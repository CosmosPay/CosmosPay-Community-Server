import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/prisma-errors';
import { WEBHOOK_EVENT, WebhookEventPayload } from '../webhooks/webhook-events';
import { redactProviderEvent } from './blindpay-event-redaction';
import { asNullableString, asString, toJson } from './blindpay.util';
import type {
  BlindpayReceiver,
  Prisma,
  WebhookEventType,
} from '../../generated/prisma/client';

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

/**
 * Payin/payout statuses that mean the money stopped moving. A webhook may move a
 * row *into* one of these at any time (`completed` -> `refunded` is a real
 * transition), but never back out — see {@link noRegressionFrom}.
 */
const SETTLED_STATUSES = [
  'completed',
  'failed',
  'refunded',
  'cancelled',
] as const;

/** Terminal BlindPay KYC statuses; mirrors `kyc/receivers/receiver-state.ts`. */
const SETTLED_KYC_STATUSES = ['approved', 'rejected'] as const;

/**
 * The bridge between BlindPay's resources and our local mirror.
 *
 * Feature services call the `mirror*` methods after a successful create so we
 * persist a consumer-scoped copy. The inbound webhook controller calls
 * {@link handleWebhook} when BlindPay reports a state change: we update the
 * mirror and re-emit a Cosmos Pay webhook event to the owning integrator so they
 * learn about it through the same channel as payment-intent events.
 */
@Injectable()
export class BlindpaySyncService {
  private readonly logger = new Logger(BlindpaySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // --- create-time mirroring (called by feature services) ------------------

  mirrorReceiver(
    consumerId: string,
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
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
    });
  }

  mirrorPayin(
    consumerId: string,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<PublicPayin> {
    const data = {
      receiverId,
      quoteId: asNullableString(obj.payin_quote_id ?? obj.quote_id),
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
    // The create/refresh response is a read path too — it is returned straight
    // to the caller by onramp.createPayin and findOne — so it is narrowed here
    // rather than at each call site, where one missed spot re-opens the leak.
    return this.prisma.payin.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
      select: PAYIN_PUBLIC_SELECT,
    });
  }

  mirrorPayout(
    consumerId: string,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<PublicPayout> {
    const data = {
      receiverId,
      quoteId: asNullableString(obj.quote_id),
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
    // Narrowed for the same reason as mirrorPayin: this return value is handed
    // straight to the caller by offramp.createPayout and findOne.
    return this.prisma.payout.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
      select: PAYOUT_PUBLIC_SELECT,
    });
  }

  // --- inbound webhook handling --------------------------------------------

  /**
   * Applies a BlindPay webhook: updates the local mirror's status and re-emits a
   * Cosmos Pay event to the resource owner. Unknown event types and events for
   * resources we never mirrored are ignored (logged), never thrown — BlindPay
   * retries on non-2xx, and we don't want to loop on events we can't attribute.
   *
   * `svixId` is the delivery identity, not the event's: Svix re-sends it
   * unchanged on every retry, which is what makes {@link claimDelivery} able to
   * tell a retry from a genuinely new state change.
   */
  async handleWebhook(
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

    // Claim before applying, so a retry of a delivery we already acted on is
    // dropped rather than re-applied and re-emitted.
    if (!(await this.claimDelivery(svixId, type))) {
      return;
    }

    const resource = type.split('.')[0];
    const owner =
      resource === 'payin'
        ? await this.applyPayin(blindpayId, data)
        : resource === 'payout'
          ? await this.applyPayout(blindpayId, data)
          : resource === 'receiver'
            ? await this.applyReceiver(blindpayId, data)
            : null;

    if (!owner) {
      this.logger.warn(
        `BlindPay webhook '${type}' for ${blindpayId} matched no local record`,
      );
      return;
    }

    // Redacted before it leaves: the provider object is the KYC dossier, and
    // subscribing to it needs only `webhooks:write`. See blindpay-event-redaction.
    this.events.emit(
      WEBHOOK_EVENT,
      new WebhookEventPayload(owner, mapped, redactProviderEvent(mapped, data)),
    );
  }

  /**
   * Claims a delivery by its `svix-id`; false means it was already handled.
   *
   * Svix re-sends the same `svix-id` until a delivery is acknowledged, so every
   * retry used to re-apply the update and re-emit the outbound event — an
   * integrator saw "payout completed" more than once for a single state change.
   * The unique index is the lock: the first insert wins, a retry loses on P2002.
   *
   * Claiming before applying means a crash in between drops the retry. The
   * mirror still converges: a single-resource read refreshes a stale row from
   * BlindPay.
   */
  private async claimDelivery(
    svixId: string,
    eventType: string,
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
        data: { svixId, eventType },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.debug(
          `Dropping replayed BlindPay delivery ${svixId} ('${eventType}')`,
        );
        return false;
      }
      throw err;
    }
  }

  /** Updates a payin's status; returns the owning consumer username or null. */
  private async applyPayin(
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<string | null> {
    const row = await this.prisma.payin.findFirst({
      where: { blindpayId },
      include: { consumer: true },
    });
    if (!row) return null;
    const status = asNullableString(obj.status);
    await this.prisma.payin.updateMany({
      where: { id: row.id, status: noRegressionFrom(status, SETTLED_STATUSES) },
      data: { status: status ?? row.status, raw: toJson(obj) },
    });
    return row.consumer.apisixUsername;
  }

  private async applyPayout(
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<string | null> {
    const row = await this.prisma.payout.findFirst({
      where: { blindpayId },
      include: { consumer: true },
    });
    if (!row) return null;
    const status = asNullableString(obj.status);
    await this.prisma.payout.updateMany({
      where: { id: row.id, status: noRegressionFrom(status, SETTLED_STATUSES) },
      data: { status: status ?? row.status, raw: toJson(obj) },
    });
    return row.consumer.apisixUsername;
  }

  private async applyReceiver(
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<string | null> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { blindpayId },
      include: { consumer: true },
    });
    if (!row) return null;
    const kycStatus = asNullableString(obj.kyc_status);
    await this.prisma.blindpayReceiver.updateMany({
      where: {
        id: row.id,
        kycStatus: noRegressionFrom(kycStatus, SETTLED_KYC_STATUSES),
      },
      data: { kycStatus: kycStatus ?? row.kycStatus, raw: toJson(obj) },
    });
    return row.consumer.apisixUsername;
  }
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
