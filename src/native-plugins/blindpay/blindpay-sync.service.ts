import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { isUniqueViolation } from '@/common/prisma-errors';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { redactProviderEvent } from '@/native-plugins/blindpay/blindpay-event-redaction';
import {
  asNullableString,
  asString,
  toJson,
} from '@/native-plugins/blindpay/blindpay.util';
import {
  BLINDPAY_COMPLETED_STATUS,
  BLINDPAY_PENDING_PROVIDER_STATUS,
  BLINDPAY_UNCONFIRMED_STATUS,
  SETTLED_KYC_STATUSES,
  SETTLED_STATUSES,
} from '@/native-plugins/blindpay/blindpay.constants';
import type {
  BlindpayQuoteKind,
  BlindpayReceiver,
  Prisma,
  WebhookEventType,
} from '@generated/prisma/client';
import type { BlindpayEnvironment } from '@/config/configuration';

/** Loosely-typed BlindPay resource object (snake_case, provider-defined). */
export type BlindpayObject = Record<string, unknown>;

/**
 * The columns a payin may leave the service with — the exact field list of
 * `PayinEntity`, the documented contract.
 *
 * `raw` is absent on purpose, for the same reason `RECEIVER_PUBLIC_SELECT`
 * omits it: it is the provider payload whole, which for a payin carries the
 * payer's identity and bank credentials. `instructions` stays — the payer
 * cannot fund the payin without it, and the entity documents it — but that is a
 * curated key list (see `pickInstructions`), not the raw blob.
 *
 * This is a `select` rather than a delete-after-read so the blob never leaves
 * PostgreSQL. Note that the entity classes enforce nothing at runtime: there is
 * no ClassSerializerInterceptor, so a field not excluded here IS returned.
 */
export const PAYIN_PUBLIC_SELECT = {
  id: true,
  blindpayId: true,
  status: true,
  token: true,
  network: true,
  paymentMethod: true,
  senderAmount: true,
  receiverAmount: true,
  instructions: true,
  createdAt: true,
} as const satisfies Prisma.PayinSelect;

export type PublicPayin = Prisma.PayinGetPayload<{
  select: typeof PAYIN_PUBLIC_SELECT;
}>;

/** As {@link PAYIN_PUBLIC_SELECT}, for payouts — the field list of `PayoutEntity`. */
export const PAYOUT_PUBLIC_SELECT = {
  id: true,
  blindpayId: true,
  status: true,
  token: true,
  network: true,
  rail: true,
  senderAmount: true,
  receiverAmount: true,
  senderWalletAddress: true,
  createdAt: true,
} as const satisfies Prisma.PayoutSelect;

export type PublicPayout = Prisma.PayoutGetPayload<{
  select: typeof PAYOUT_PUBLIC_SELECT;
}>;

/** As above, for virtual accounts. */
export const VIRTUAL_ACCOUNT_PUBLIC_SELECT = {
  id: true,
  blindpayId: true,
  blockchainWalletId: true,
  token: true,
  status: true,
  createdAt: true,
} as const satisfies Prisma.BlindpayVirtualAccountSelect;

export type PublicVirtualAccount = Prisma.BlindpayVirtualAccountGetPayload<{
  select: typeof VIRTUAL_ACCOUNT_PUBLIC_SELECT;
}>;

/**
 * Maps a BlindPay webhook event name to the internal event we re-emit to
 * integrators, or null when the event has no integrator-facing counterpart.
 */
const EVENT_MAP: Record<string, WebhookEventType> = {
  'receiver.new': 'RECEIVER_UPDATED',
  'receiver.update': 'RECEIVER_UPDATED',
  'payin.new': 'PAYIN_CREATED',
  'payin.update': 'PAYIN_UPDATED',
  'payin.complete': 'PAYIN_COMPLETED',
  'payout.new': 'PAYOUT_CREATED',
  'payout.update': 'PAYOUT_UPDATED',
  'payout.complete': 'PAYOUT_COMPLETED',
};

/** The two resources a quote executes into — the ones a row is opened for. */
export type MoneyResource = 'payin' | 'payout';

/**
 * The event a status change found by reading the provider (not by a webhook) is
 * announced as: the completion when that is where the row arrived, an update
 * otherwise. `completed` is also the one terminal event of each resource.
 */
const RESOURCE_EVENTS: Readonly<
  Record<
    MoneyResource,
    { completed: WebhookEventType; updated: WebhookEventType }
  >
> = {
  payin: { completed: 'PAYIN_COMPLETED', updated: 'PAYIN_UPDATED' },
  payout: { completed: 'PAYOUT_COMPLETED', updated: 'PAYOUT_UPDATED' },
};

/** A row opened before the provider call; see BLINDPAY_PENDING_PROVIDER_STATUS. */
export interface OpenedRow {
  id: string;
  createdAt: Date;
  /** False when a retried create found the row its first attempt opened. */
  isNew: boolean;
}

/** A mirrored payin/payout as the webhook and the reconciler need it. */
export interface MirrorRef {
  id: string;
  status: string | null;
  owner: string;
}

/** An inbound event the webhook acknowledged without finding a row for it. */
export interface OpenWebhookEvent {
  svixId: string;
  eventType: string;
}

/** What applying an event, or a provider read, to the mirror came to. */
interface MirrorOutcome {
  /** The owning consumer's username — whom to notify. */
  owner: string;
  /** Whether the row's state moved, so a non-terminal event may be re-emitted. */
  transitioned: boolean;
}

/** Applies one webhook to its local mirror; null when no row is (or can be) attributed. */
type MirrorApplier = (
  environment: BlindpayEnvironment,
  blindpayId: string,
  obj: BlindpayObject,
) => Promise<MirrorOutcome | null>;

/**
 * What a guarded write puts on the row besides the status: only the payload
 * (`raw`, what a webhook on a known row has always written), or every mirrored
 * field and the provider id (`fields`, for filling an opened row and for the
 * reconciler's refresh).
 */
type TransitionWrite = 'raw' | 'fields';

/**
 * How a status write is guarded. `requireChange` also refuses a write that would
 * leave the status where it is — the reconciler polls, and must not announce
 * the same state every minute.
 */
interface TransitionOptions {
  write: TransitionWrite;
  requireChange: boolean;
  /** Written whether or not the guarded write lands. */
  always?: { receiverId?: string | null; lastCheckedAt?: Date };
}

/**
 * One payin or payout table, behind the operations the webhook, the create
 * path and the reconciler share. Two implementations of one shape (see
 * {@link BlindpaySyncService.stores}), so the flows are written once rather
 * than once per table.
 */
interface MirrorStore {
  quoteKind: BlindpayQuoteKind;
  quoteIdOf(obj: BlindpayObject): string | null;
  findByProviderId(
    environment: BlindpayEnvironment,
    blindpayId: string,
  ): Promise<MirrorRef | null>;
  /** The row a create opened for this quote and no provider id has reached yet. */
  findOpen(
    consumerId: string,
    environment: BlindpayEnvironment,
    quoteId: string,
  ): Promise<{ id: string } | null>;
  /**
   * Writes the provider's state onto row `id`; the status only where the guard
   * allows it. True when the guarded write landed.
   */
  transition(
    id: string,
    obj: BlindpayObject,
    opts: TransitionOptions,
  ): Promise<boolean>;
  mirror(
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<unknown>;
  /** Deletes an opened row, only while it still has no provider id. */
  discard(id: string): Promise<void>;
  /** Moves rows waiting for a provider id since before `before`; returns their ids. */
  markUnconfirmed(
    environment: BlindpayEnvironment,
    before: Date,
  ): Promise<string[]>;
  touchChecked(id: string): Promise<void>;
  readPublic(consumerId: string, blindpayId: string): Promise<unknown>;
}

/**
 * The bridge between BlindPay's resources and our local mirror.
 *
 * Feature services open a payin/payout row BEFORE the provider call
 * ({@link openPayin} / {@link openPayout}) and attach the provider's answer to
 * it afterwards ({@link attachCreatedPayin} / {@link attachCreatedPayout}), so
 * a resource BlindPay created is never one we have no row for. The inbound
 * webhook controller calls {@link handleWebhook} when BlindPay reports a state
 * change: we update the mirror — creating or repairing it through the quote's
 * owner when the create path never got that far — and re-emit a Cosmos Pay
 * webhook event to the owning integrator so they learn about it through the
 * same channel as payment-intent events. The reconciler drives
 * {@link reconcile} and {@link retryOpenEvent} for whatever the webhook did not
 * settle.
 */
@Injectable()
export class BlindpaySyncService {
  private readonly logger = new Logger(BlindpaySyncService.name);

  /**
   * Which mirror an event updates, keyed by the resource half of its name
   * (`payout.complete` -> `payout`). The companion to {@link EVENT_MAP}: a new
   * event family is one entry in each table, not another branch in
   * {@link handleWebhook}.
   */
  private readonly appliers: Readonly<Record<string, MirrorApplier>> = {
    payin: (env, id, obj) => this.applyMoney('payin', env, id, obj),
    payout: (env, id, obj) => this.applyMoney('payout', env, id, obj),
    receiver: (env, id, obj) => this.applyReceiver(env, id, obj),
  };

  /** The two money tables, behind one shape; see {@link MirrorStore}. */
  private readonly stores: Readonly<Record<MoneyResource, MirrorStore>> = {
    payin: this.payinStore(),
    payout: this.payoutStore(),
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: WebhookTerminalEmitter,
  ) {}

  // --- create-time mirroring (called by feature services) ------------------
  //
  // Each mirror row records the instance it came from. The provider ids of two
  // instances never collide, but a tenant's dev and prod keys resolve to the
  // same consumer, so the environment is what keeps a dev key's reads and writes
  // off rows that describe real identities and real money.

  mirrorReceiver(
    consumerId: string,
    environment: BlindpayEnvironment,
    obj: BlindpayObject,
  ): Promise<BlindpayReceiver> {
    const data = {
      type: asNullableString(obj.type) ?? 'individual',
      kycType: asNullableString(obj.kyc_type),
      kycStatus: asNullableString(obj.kyc_status),
      email: asNullableString(obj.email),
      name: receiverName(obj),
      country: asNullableString(obj.country),
      externalId: asNullableString(obj.external_id),
      raw: toJson(obj),
    };
    return this.prisma.blindpayReceiver.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: {
        consumerId,
        environment,
        blindpayId: asString(obj.id),
        ...data,
      },
      update: data,
    });
  }

  mirrorPayin(
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<PublicPayin> {
    const data = { receiverId, ...payinFields(obj) };
    // The create/refresh response is a read path too — it is returned straight
    // to the caller by onramp.createPayin and findOne — so it is narrowed here
    // rather than at each call site, where one missed spot re-opens the leak.
    return this.prisma.payin.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: {
        consumerId,
        environment,
        blindpayId: asString(obj.id),
        ...data,
      },
      update: data,
      select: PAYIN_PUBLIC_SELECT,
    });
  }

  mirrorPayout(
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<PublicPayout> {
    const data = { receiverId, ...payoutFields(obj) };
    // Narrowed for the same reason as mirrorPayin: this return value is handed
    // straight to the caller by offramp.createPayout and findOne.
    return this.prisma.payout.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: {
        consumerId,
        environment,
        blindpayId: asString(obj.id),
        ...data,
      },
      update: data,
      select: PAYOUT_PUBLIC_SELECT,
    });
  }

  /**
   * Opens the payin row for a quote BEFORE asking BlindPay to execute it. A
   * retried create — same quote, so same execution key — gets back the row its
   * first attempt opened, whatever became of that attempt.
   */
  async openPayin(
    consumerId: string,
    environment: BlindpayEnvironment,
    quote: { quoteId: string; executionKey: string },
  ): Promise<OpenedRow> {
    try {
      const row = await this.prisma.payin.create({
        data: {
          consumerId,
          environment,
          quoteId: quote.quoteId,
          executionKey: quote.executionKey,
          status: BLINDPAY_PENDING_PROVIDER_STATUS,
        },
        select: { id: true, createdAt: true },
      });
      return { ...row, isNew: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const row = await this.prisma.payin.findUnique({
        where: { executionKey: quote.executionKey },
        select: { id: true, createdAt: true, consumerId: true },
      });
      return reopened(row, consumerId, err);
    }
  }

  /** As {@link openPayin}, for a payout. */
  async openPayout(
    consumerId: string,
    environment: BlindpayEnvironment,
    quote: {
      quoteId: string;
      executionKey: string;
      senderWalletAddress: string | null;
    },
  ): Promise<OpenedRow> {
    try {
      const row = await this.prisma.payout.create({
        data: {
          consumerId,
          environment,
          quoteId: quote.quoteId,
          executionKey: quote.executionKey,
          senderWalletAddress: quote.senderWalletAddress,
          status: BLINDPAY_PENDING_PROVIDER_STATUS,
        },
        select: { id: true, createdAt: true },
      });
      return { ...row, isNew: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const row = await this.prisma.payout.findUnique({
        where: { executionKey: quote.executionKey },
        select: { id: true, createdAt: true, consumerId: true },
      });
      return reopened(row, consumerId, err);
    }
  }

  /**
   * Drops a row opened for a provider call that certainly created nothing (see
   * `isProviderRefusal`). Only while it still has no provider id: a webhook
   * that attached one in the meantime proves the refusal wrong.
   */
  discardOpened(resource: MoneyResource, id: string): Promise<void> {
    return this.stores[resource].discard(id);
  }

  /**
   * Attaches the payin BlindPay just created to the row opened for it, and
   * returns the public projection the create route answers with. See
   * {@link attachCreated}.
   */
  async attachCreatedPayin(
    opened: OpenedRow,
    consumerId: string,
    environment: BlindpayEnvironment,
    created: BlindpayObject,
  ): Promise<PublicPayin> {
    const row = await this.attachCreated(
      'payin',
      opened,
      consumerId,
      environment,
      created,
    );
    return (row as PublicPayin | null) ?? publicPayinFrom(opened, created);
  }

  /** As {@link attachCreatedPayin}, for a payout. */
  async attachCreatedPayout(
    opened: OpenedRow,
    consumerId: string,
    environment: BlindpayEnvironment,
    created: BlindpayObject,
  ): Promise<PublicPayout> {
    const row = await this.attachCreated(
      'payout',
      opened,
      consumerId,
      environment,
      created,
    );
    return (row as PublicPayout | null) ?? publicPayoutFrom(opened, created);
  }

  // --- inbound webhook handling --------------------------------------------

  /**
   * Applies a BlindPay webhook: updates the local mirror's status and re-emits a
   * Cosmos Pay event to the resource owner. Unknown event types are ignored
   * (logged), never thrown — BlindPay retries on non-2xx, and we don't want to
   * loop on events we can't attribute.
   *
   * A payin/payout event that matches no row is attributed through the quote it
   * executed: `BlindpayQuote` says which consumer minted it, so the mirror is
   * created there, or the row a create opened for it is filled in. One that
   * cannot be attributed even so is acknowledged but stays OPEN — its delivery
   * row has no `appliedAt` — and the reconciler re-reads it from BlindPay until
   * it can be. Answering non-2xx instead would have Svix retry it for about a
   * day and then disable the endpoint over events no retry can fix (a payout
   * made on the shared instance by something else), taking every tenant's
   * deliveries down with it.
   *
   * `svixId` is the delivery identity, not the event's: Svix re-sends it
   * unchanged on every retry, which is what makes {@link claimDelivery} able to
   * tell a retry from a genuinely new state change.
   *
   * `environment` is the instance whose secret verified the delivery. Only that
   * instance's rows are looked up, so a delivery signed for one instance can
   * never move a row that belongs to the other.
   */
  async handleWebhook(
    environment: BlindpayEnvironment,
    type: string,
    data: BlindpayObject,
    svixId: string,
  ): Promise<void> {
    const mapped = EVENT_MAP[type];
    const blindpayId = data.id ? asString(data.id) : null;

    if (!mapped || !blindpayId) {
      this.logger.debug(`Ignoring BlindPay webhook '${type}' (no mapping/id)`);
      return;
    }

    // Recorded before applying, so a retry of a delivery we already acted on is
    // dropped rather than re-applied and re-emitted.
    if (!(await this.claimDelivery(svixId, type, environment, blindpayId))) {
      return;
    }

    const resource = type.split('.')[0];
    // Own keys only: a plain object also answers to `toString` and friends, and
    // a resource by that name has to fall through to "no local record" as it
    // always did, not call into Object.prototype.
    const apply = Object.hasOwn(this.appliers, resource)
      ? this.appliers[resource]
      : undefined;
    const outcome = apply ? await apply(environment, blindpayId, data) : null;

    if (!outcome) {
      if (isMoneyResource(resource) && svixId) {
        this.logger.warn(
          `BlindPay webhook '${type}' for ${blindpayId} matched no local record; kept open (svix-id ${svixId}) for the reconciler`,
        );
        return;
      }
      this.logger.warn(
        `BlindPay webhook '${type}' for ${blindpayId} matched no local record`,
      );
      await this.closeDelivery(svixId);
      return;
    }

    if (!(await this.closeDelivery(svixId))) return;
    await this.announce(outcome, mapped, data);
  }

  /**
   * Re-tries an open webhook event against what BlindPay says the resource is
   * NOW. `fresh` is the reconciler's read of it, so the mirror is built from
   * current state, and the event the delivery stood for is the one announced.
   * Returns whether the event could be attributed at last.
   */
  async retryOpenEvent(
    event: OpenWebhookEvent,
    environment: BlindpayEnvironment,
    fresh: BlindpayObject,
  ): Promise<boolean> {
    const mapped = EVENT_MAP[event.eventType];
    const resource = event.eventType.split('.')[0];
    const blindpayId = asString(fresh.id);
    const outcome =
      mapped && isMoneyResource(resource) && blindpayId
        ? await this.applyMoney(resource, environment, blindpayId, fresh)
        : null;
    if (!outcome || !mapped) {
      await this.noteOpenEventAttempt(event.svixId);
      return false;
    }
    // The delivery stands for one notification; whichever path closes it is
    // the one that sends it.
    if (await this.closeDelivery(event.svixId)) {
      await this.announce(outcome, mapped, fresh);
    }
    return true;
  }

  /** Moves an open event to the back of the reconciler's queue. */
  async noteOpenEventAttempt(svixId: string): Promise<void> {
    await this.prisma.blindpayWebhookEvent.updateMany({
      where: { svixId, appliedAt: null },
      data: { lastAttemptAt: new Date() },
    });
  }

  /**
   * Brings a mirrored payin/payout up to what BlindPay says it is, and
   * announces the change — once: only a write that actually moved the status
   * notifies, and a completion goes through the terminal emitter, whose claim
   * the webhook's own completion shares.
   */
  async reconcile(
    resource: MoneyResource,
    row: MirrorRef & { blindpayId: string },
    fresh: BlindpayObject,
  ): Promise<boolean> {
    // The read was by this id; an answer about another resource is not one to
    // write over this row.
    if (asString(fresh.id) !== row.blindpayId) {
      throw new Error(
        `BlindPay answered a read of ${row.blindpayId} with ${asString(fresh.id) || 'no id'}`,
      );
    }
    const moved = await this.stores[resource].transition(row.id, fresh, {
      write: 'fields',
      requireChange: true,
      always: { lastCheckedAt: new Date() },
    });
    if (!moved) return false;
    const status = asNullableString(fresh.status);
    const events = RESOURCE_EVENTS[resource];
    await this.announce(
      { owner: row.owner, transitioned: true },
      status === BLINDPAY_COMPLETED_STATUS ? events.completed : events.updated,
      fresh,
    );
    return true;
  }

  /** Records that the reconciler looked at a row it could not read upstream. */
  touchChecked(resource: MoneyResource, id: string): Promise<void> {
    return this.stores[resource].touchChecked(id);
  }

  /**
   * Moves rows that waited for a provider id since before `before` to
   * BLINDPAY_UNCONFIRMED_STATUS, and logs each — an operator has to look at
   * them, since nothing here can tell whether BlindPay holds the resource.
   */
  async markUnconfirmed(
    resource: MoneyResource,
    environment: BlindpayEnvironment,
    before: Date,
  ): Promise<number> {
    const ids = await this.stores[resource].markUnconfirmed(
      environment,
      before,
    );
    for (const id of ids) {
      this.logger.error(
        `BlindPay ${resource} row ${id} (${environment}) never received a provider id; marked ${BLINDPAY_UNCONFIRMED_STATUS}`,
      );
    }
    return ids.length;
  }

  /**
   * The provider's answer to a create, attached to the row opened for it; the
   * public row, or null when it could not be recorded.
   *
   * The provider already holds the payin/payout by now, so a failure here must
   * not turn into an error the caller retries as if nothing happened — nor lose
   * the provider id. The row keeps its quote and execution key either way: the
   * webhook attaches the id by `quote_id`, and a retried create replays the same
   * Idempotency-Key and lands here again. What is logged is the redacted
   * provider object (the integrator-facing allowlist, no bank details), and the
   * caller gets the same shape it would have got from the row.
   */
  private async attachCreated(
    resource: MoneyResource,
    opened: OpenedRow,
    consumerId: string,
    environment: BlindpayEnvironment,
    created: BlindpayObject,
  ): Promise<unknown> {
    const blindpayId = asString(created.id);
    if (!blindpayId) {
      // Nothing to attach, and nothing to answer with. The row stays open; the
      // webhook can still attribute the resource through its quote.
      this.logger.error(
        `BlindPay answered a ${resource} create for row ${opened.id} without an id`,
      );
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `BlindPay returned a ${resource} without an id.`,
      );
    }
    try {
      const receiverId = await this.localReceiverId(
        consumerId,
        environment,
        created.receiver_id,
      );
      await this.attachOrMerge(
        resource,
        opened.id,
        consumerId,
        environment,
        receiverId,
        created,
      );
      return await this.stores[resource].readPublic(consumerId, blindpayId);
    } catch (err) {
      this.logger.error(
        `BlindPay created ${resource} ${blindpayId} for row ${opened.id}, but recording it failed (${
          err instanceof Error ? err.message : String(err)
        }); it stays attributable by quote. Provider object: ${JSON.stringify(
          redactProviderEvent(RESOURCE_EVENTS[resource].updated, created),
        )}`,
      );
      return null;
    }
  }

  /**
   * Records a delivery by its `svix-id`; false means it was already handled.
   *
   * Svix re-sends the same `svix-id` until a delivery is acknowledged, so every
   * retry used to re-apply the update and re-emit the outbound event — an
   * integrator saw "payout completed" more than once for a single state change.
   * The unique index is the lock: the first insert wins, a retry loses on P2002.
   *
   * Losing it means "already handled" only once the claim is closed
   * (`appliedAt`). A claim left open — the event matched nothing, or the process
   * died between recording and applying — is applied again by the retry, so
   * neither case drops the event; {@link closeDelivery} keeps the notification
   * to one.
   */
  private async claimDelivery(
    svixId: string,
    eventType: string,
    environment: BlindpayEnvironment,
    blindpayId: string,
  ): Promise<boolean> {
    if (!svixId) {
      // Unreachable behind the signature check — the id is part of the signed
      // content — but processing unclaimed beats dropping a real state change.
      this.logger.warn(
        `BlindPay webhook '${eventType}' arrived without an svix-id; processing without dedup`,
      );
      return true;
    }
    try {
      await this.prisma.blindpayWebhookEvent.create({
        data: { svixId, eventType, environment, blindpayId },
      });
      return true;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const prior = await this.prisma.blindpayWebhookEvent.findUnique({
        where: { svixId },
        select: { appliedAt: true },
      });
      if (prior && !prior.appliedAt) return true;
      this.logger.debug(
        `Dropping replayed BlindPay delivery ${svixId} ('${eventType}')`,
      );
      return false;
    }
  }

  /**
   * Closes a recorded delivery. True for the one caller that closed it — the
   * webhook, its own retry, or the reconciler — which is the one that notifies.
   */
  private async closeDelivery(svixId: string): Promise<boolean> {
    if (!svixId) return true;
    const { count } = await this.prisma.blindpayWebhookEvent.updateMany({
      where: { svixId, appliedAt: null },
      data: { appliedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Re-emits an applied change to its owner.
   *
   * A completion goes through the terminal emitter, whose claim is keyed by the
   * event and the resource: BlindPay may send `payout.complete` again under a
   * NEW `svix-id`, and the reconciler can find the same completion, so the
   * delivery claim alone let each of those notify again with a new `evt_`.
   * Anything else is re-emitted only when the write moved the row — a guarded
   * write that refused a regression changed nothing worth announcing.
   *
   * Redacted before it leaves: the provider object is the KYC dossier, and
   * subscribing to it needs only `webhooks:write`. See blindpay-event-redaction.
   */
  private async announce(
    outcome: MirrorOutcome,
    type: WebhookEventType,
    data: BlindpayObject,
  ): Promise<void> {
    const terminal =
      type === RESOURCE_EVENTS.payin.completed ||
      type === RESOURCE_EVENTS.payout.completed;
    if (!terminal && !outcome.transitioned) return;
    await this.emitter.emit(
      outcome.owner,
      type,
      redactProviderEvent(type, data),
    );
  }

  /**
   * Applies a payin/payout event to its row, or — when there is none — to the
   * row its quote's owner should have. Null when neither exists.
   */
  private async applyMoney(
    resource: MoneyResource,
    environment: BlindpayEnvironment,
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<MirrorOutcome | null> {
    const store = this.stores[resource];
    const row = await store.findByProviderId(environment, blindpayId);
    if (row) {
      const transitioned = await store.transition(row.id, obj, {
        write: 'raw',
        requireChange: false,
      });
      return { owner: row.owner, transitioned };
    }
    return this.attribute(resource, environment, obj);
  }

  /**
   * Creates or repairs the mirror of a payin/payout we hold no row for, on the
   * word of the quote it executed.
   *
   * The quote is the binding this service already trusts: `BlindpayQuote` is
   * written when a consumer mints it and is what authorized the execution, and
   * the event itself is signed by the instance it names. A quote id that
   * resolves to more than one owner is refused rather than guessed between.
   */
  private async attribute(
    resource: MoneyResource,
    environment: BlindpayEnvironment,
    obj: BlindpayObject,
  ): Promise<MirrorOutcome | null> {
    const store = this.stores[resource];
    const quoteId = store.quoteIdOf(obj);
    if (!quoteId) return null;
    const quotes = await this.prisma.blindpayQuote.findMany({
      where: { environment, blindpayId: quoteId, kind: store.quoteKind },
      select: {
        consumerId: true,
        consumer: { select: { apisixUsername: true } },
      },
      take: 2,
    });
    if (quotes.length !== 1) return null;
    const [{ consumerId, consumer }] = quotes;

    const receiverId = await this.localReceiverId(
      consumerId,
      environment,
      obj.receiver_id,
    );
    const open = await store.findOpen(consumerId, environment, quoteId);
    await this.attachOrMerge(
      resource,
      open?.id ?? null,
      consumerId,
      environment,
      receiverId,
      obj,
    );
    this.logger.log(
      `BlindPay ${resource} ${asString(obj.id)} attributed through quote ${quoteId} (${
        open ? 'filled the open row' : 'mirror created'
      })`,
    );
    return { owner: consumer.apisixUsername, transitioned: true };
  }

  /**
   * Gives row `openId` its provider id and fields, or — with no open row, or
   * when another row already holds that provider id (one mirrored before rows
   * were opened first) — upserts the mirror by provider id and drops the open
   * row, so one payout never has two rows.
   */
  private async attachOrMerge(
    resource: MoneyResource,
    openId: string | null,
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<void> {
    const store = this.stores[resource];
    if (openId) {
      try {
        await store.transition(openId, obj, {
          write: 'fields',
          requireChange: false,
          always: { receiverId },
        });
        return;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await store.discard(openId);
      }
    }
    await store.mirror(consumerId, environment, receiverId, obj);
  }

  /** The local id of a receiver the consumer owns on this instance, or null. */
  private async localReceiverId(
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverBlindpayId: unknown,
  ): Promise<string | null> {
    const blindpayId = asString(receiverBlindpayId);
    if (!blindpayId) return null;
    const receiver = await this.prisma.blindpayReceiver.findFirst({
      where: { consumerId, environment, blindpayId },
      select: { id: true },
    });
    return receiver?.id ?? null;
  }

  private async applyReceiver(
    environment: BlindpayEnvironment,
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<MirrorOutcome | null> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { blindpayId, environment },
      include: { consumer: true },
    });
    if (!row) return null;
    const kycStatus = asNullableString(obj.kyc_status);
    const { count } = await this.prisma.blindpayReceiver.updateMany({
      where: {
        id: row.id,
        kycStatus: noRegressionFrom(kycStatus, SETTLED_KYC_STATUSES),
      },
      data: { kycStatus: kycStatus ?? row.kycStatus, raw: toJson(obj) },
    });
    return { owner: row.consumer.apisixUsername, transitioned: count === 1 };
  }

  private payinStore(): MirrorStore {
    const table = () => this.prisma.payin;
    return {
      quoteKind: 'PAYIN',
      quoteIdOf: (obj) => asNullableString(obj.payin_quote_id ?? obj.quote_id),
      findByProviderId: async (environment, blindpayId) => {
        const row = await table().findFirst({
          where: { blindpayId, environment },
          select: MIRROR_REF_SELECT,
        });
        return row && toMirrorRef(row);
      },
      findOpen: (consumerId, environment, quoteId) =>
        table().findFirst({
          where: { consumerId, environment, quoteId, blindpayId: null },
          select: { id: true },
        }),
      transition: async (id, obj, opts) => {
        const { status, ...fields } = payinFields(obj);
        const written =
          opts.write === 'raw'
            ? { raw: fields.raw }
            : { blindpayId: asString(obj.id), ...fields };
        const { count } = await table().updateMany({
          where: { id, ...statusGuard(status, opts) },
          data: { ...written, ...opts.always, status: status ?? undefined },
        });
        const rest = opts.write === 'fields' ? written : {};
        if (count === 0 && (opts.always || opts.write === 'fields')) {
          await table().update({
            where: { id },
            data: { ...rest, ...opts.always },
          });
        }
        return count === 1;
      },
      mirror: (consumerId, environment, receiverId, obj) =>
        this.mirrorPayin(consumerId, environment, receiverId, obj),
      discard: async (id) => {
        await table().deleteMany({ where: { id, blindpayId: null } });
      },
      markUnconfirmed: async (environment, before) => {
        const where = unconfirmedWhere(environment, before);
        const rows = await table().findMany({ where, select: { id: true } });
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        await table().updateMany({
          where: { ...where, id: { in: ids } },
          data: { status: BLINDPAY_UNCONFIRMED_STATUS },
        });
        return ids;
      },
      touchChecked: async (id) => {
        await table().updateMany({
          where: { id },
          data: { lastCheckedAt: new Date() },
        });
      },
      readPublic: (consumerId, blindpayId) =>
        table().findUniqueOrThrow({
          where: { consumerId_blindpayId: { consumerId, blindpayId } },
          select: PAYIN_PUBLIC_SELECT,
        }),
    };
  }

  private payoutStore(): MirrorStore {
    const table = () => this.prisma.payout;
    return {
      quoteKind: 'PAYOUT',
      quoteIdOf: (obj) => asNullableString(obj.quote_id),
      findByProviderId: async (environment, blindpayId) => {
        const row = await table().findFirst({
          where: { blindpayId, environment },
          select: MIRROR_REF_SELECT,
        });
        return row && toMirrorRef(row);
      },
      findOpen: (consumerId, environment, quoteId) =>
        table().findFirst({
          where: { consumerId, environment, quoteId, blindpayId: null },
          select: { id: true },
        }),
      transition: async (id, obj, opts) => {
        const { status, ...fields } = payoutFields(obj);
        const written =
          opts.write === 'raw'
            ? { raw: fields.raw }
            : { blindpayId: asString(obj.id), ...fields };
        const { count } = await table().updateMany({
          where: { id, ...statusGuard(status, opts) },
          data: { ...written, ...opts.always, status: status ?? undefined },
        });
        const rest = opts.write === 'fields' ? written : {};
        if (count === 0 && (opts.always || opts.write === 'fields')) {
          await table().update({
            where: { id },
            data: { ...rest, ...opts.always },
          });
        }
        return count === 1;
      },
      mirror: (consumerId, environment, receiverId, obj) =>
        this.mirrorPayout(consumerId, environment, receiverId, obj),
      discard: async (id) => {
        await table().deleteMany({ where: { id, blindpayId: null } });
      },
      markUnconfirmed: async (environment, before) => {
        const where = unconfirmedWhere(environment, before);
        const rows = await table().findMany({ where, select: { id: true } });
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        await table().updateMany({
          where: { ...where, id: { in: ids } },
          data: { status: BLINDPAY_UNCONFIRMED_STATUS },
        });
        return ids;
      },
      touchChecked: async (id) => {
        await table().updateMany({
          where: { id },
          data: { lastCheckedAt: new Date() },
        });
      },
      readPublic: (consumerId, blindpayId) =>
        table().findUniqueOrThrow({
          where: { consumerId_blindpayId: { consumerId, blindpayId } },
          select: PAYOUT_PUBLIC_SELECT,
        }),
    };
  }
}

/** The columns {@link MirrorRef} is read from, identical for both tables. */
const MIRROR_REF_SELECT = {
  id: true,
  status: true,
  consumer: { select: { apisixUsername: true } },
} as const;

function toMirrorRef(row: {
  id: string;
  status: string | null;
  consumer: { apisixUsername: string };
}): MirrorRef {
  return { id: row.id, status: row.status, owner: row.consumer.apisixUsername };
}

function isMoneyResource(resource: string): resource is MoneyResource {
  return resource === 'payin' || resource === 'payout';
}

/**
 * The row a retried create gets back: the one its first attempt opened under
 * the same execution key. The key is minted per quote, and the quote was proven
 * to be this consumer's, so a row under it belonging to anyone else cannot
 * happen; if it ever does, the original conflict is the only answer that leaks
 * nothing.
 */
function reopened(
  row: { id: string; createdAt: Date; consumerId: string } | null,
  consumerId: string,
  conflict: unknown,
): OpenedRow {
  if (!row || row.consumerId !== consumerId) throw conflict;
  return { id: row.id, createdAt: row.createdAt, isNew: false };
}

/** Rows still waiting for a provider id that were opened before `before`. */
function unconfirmedWhere(environment: BlindpayEnvironment, before: Date) {
  return {
    environment,
    blindpayId: null,
    status: BLINDPAY_PENDING_PROVIDER_STATUS,
    createdAt: { lt: before },
  };
}

/**
 * The provider fields a payin row mirrors. `quoteId` is left out when the
 * payload has none, so a row opened with its quote keeps it: that column is how
 * a later event finds the row.
 */
function payinFields(obj: BlindpayObject) {
  const quoteId = asNullableString(obj.payin_quote_id ?? obj.quote_id);
  return {
    ...(quoteId ? { quoteId } : {}),
    status: asNullableString(obj.status),
    token: asNullableString(obj.token),
    network: asNullableString(obj.network),
    paymentMethod: asNullableString(obj.payment_method),
    currency: asNullableString(obj.currency),
    senderAmount: asNullableString(obj.sender_amount),
    receiverAmount: asNullableString(obj.receiver_amount),
    instructions: toJson(pickInstructions(obj)),
    raw: toJson(obj),
  };
}

/** As {@link payinFields}, for a payout. */
function payoutFields(obj: BlindpayObject) {
  const quoteId = asNullableString(obj.quote_id);
  return {
    ...(quoteId ? { quoteId } : {}),
    status: asNullableString(obj.status),
    token: asNullableString(obj.token),
    network: asNullableString(obj.network),
    rail: asNullableString(obj.rail ?? obj.payment_method),
    bankAccountId: asNullableString(obj.bank_account_id),
    senderAmount: asNullableString(obj.sender_amount),
    receiverAmount: asNullableString(obj.receiver_amount),
    senderWalletAddress: asNullableString(obj.sender_wallet_address),
    raw: toJson(obj),
  };
}

/**
 * The public payin a create answers with when its row could not be written:
 * the shape of {@link PAYIN_PUBLIC_SELECT}, from the provider's answer and the
 * opened row's own id.
 */
function publicPayinFrom(opened: OpenedRow, obj: BlindpayObject): PublicPayin {
  const fields = payinFields(obj);
  return {
    id: opened.id,
    blindpayId: asString(obj.id),
    status: fields.status,
    token: fields.token,
    network: fields.network,
    paymentMethod: fields.paymentMethod,
    senderAmount: fields.senderAmount,
    receiverAmount: fields.receiverAmount,
    // The same curated key list the column holds; see pickInstructions.
    instructions: pickInstructions(obj) as Prisma.JsonObject,
    createdAt: opened.createdAt,
  };
}

/** As {@link publicPayinFrom}, for a payout. */
function publicPayoutFrom(
  opened: OpenedRow,
  obj: BlindpayObject,
): PublicPayout {
  const fields = payoutFields(obj);
  return {
    id: opened.id,
    blindpayId: asString(obj.id),
    status: fields.status,
    token: fields.token,
    network: fields.network,
    rail: fields.rail,
    senderAmount: fields.senderAmount,
    receiverAmount: fields.receiverAmount,
    senderWalletAddress: fields.senderWalletAddress,
    createdAt: opened.createdAt,
  };
}

/**
 * The status half of a guarded write's `where`. Without `requireChange` it is
 * {@link noRegressionFrom} alone; with it, a write that would leave the status
 * as it is matches nothing either — a NULL status counts as different.
 */
function statusGuard(
  incoming: string | null,
  opts: TransitionOptions,
): Prisma.PayinWhereInput & Prisma.PayoutWhereInput {
  const noRegression = noRegressionFrom(incoming, SETTLED_STATUSES);
  if (!opts.requireChange || incoming === null) {
    return { status: noRegression };
  }
  return {
    AND: [
      { status: noRegression },
      { OR: [{ status: null }, { status: { not: incoming } }] },
    ],
  };
}

/**
 * The `where` fragment that stops a webhook from dragging a settled row back
 * into an in-flight state, or `undefined` (no constraint) when the incoming
 * status is itself settled.
 *
 * Svix guarantees delivery, not order: a retried `payin.update` can land after
 * `payin.complete`, and the old read-then-write applied whatever arrived last —
 * regressing settled fiat to in-flight. BlindPay's payload carries no revision
 * we could compare instead, and our own `updatedAt` records when *we* wrote, not
 * when the provider changed, so it cannot order two upstream events. Entering a
 * settled state stays allowed so `completed` -> `refunded` still lands. The
 * predicate is evaluated by the database, so two concurrent deliveries cannot
 * both decide they won.
 */
function noRegressionFrom(
  incoming: string | null,
  settled: readonly string[],
): { notIn: string[] } | undefined {
  return incoming !== null && settled.includes(incoming)
    ? undefined
    : { notIn: [...settled] };
}

/** Derives a display name from an individual or business receiver payload. */
function receiverName(obj: BlindpayObject): string | null {
  const legal = asNullableString(obj.legal_name);
  if (legal) return legal;
  const full = [obj.first_name, obj.last_name]
    .map(asString)
    .filter(Boolean)
    .join(' ')
    .trim();
  return full || asNullableString(obj.name);
}

/**
 * Extracts the payer-facing funding instructions from a payin payload. Different
 * rails surface different fields (US bank details + memo, PIX code, CLABE, CBU,
 * PSE link); we keep whichever are present.
 */
function pickInstructions(obj: BlindpayObject): Record<string, unknown> {
  const keys = [
    'memo_code',
    'blindpay_bank_details',
    'pix_code',
    'clabe',
    'cbu',
    'pse_payment_link',
    'pse_full_name',
    'pse_tax_id',
    'pse_document_type',
    'virtual_account',
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      out[key] = obj[key];
    }
  }
  return out;
}
