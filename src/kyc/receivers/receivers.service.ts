import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { page } from '@/common/pagination';
import { PrismaService } from '@/prisma/prisma.service';
import { BlindpayClient } from '@/blindpay/blindpay.client';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  BlindpaySyncService,
  BlindpayObject,
} from '@/blindpay/blindpay-sync.service';
import { asNullableString, asString, toJson } from '@/blindpay/blindpay.util';
import type { BlindpayReceiver, Prisma } from '@generated/prisma/client';
import type { AdminAuditData } from '@/admin/admin-audit.service';
import { recordAuditInTransaction } from '@/admin/admin-audit.service';
import { CreateReceiverDto } from '@/kyc/receivers/dto/create-receiver.dto';
import { UpdateReceiverDto } from '@/kyc/receivers/dto/update-receiver.dto';
import { RequestTosDto } from '@/kyc/receivers/dto/request-tos.dto';
import type { AppConfig } from '@/config/configuration';
import { assertRedirectAllowed } from '@/kyc/redirect-url-whitelist';
import { assertTransition } from '@/kyc/receivers/receiver-state';
import {
  LOCAL_RECEIVER_PREFIX,
  TOS_EMAIL_COOLDOWN_MS,
} from '@/kyc/kyc.constants';

/**
 * The columns a receiver is allowed to leave this service with — deliberately the
 * exact field list of `ReceiverEntity`, the documented contract.
 *
 * `raw` is absent on purpose. It holds the full create payload: `tax_id`,
 * `date_of_birth`, `selfie_file`, `id_doc_front_file`, address, phone — and the same
 * again for every beneficial owner in `owners[]`. It stays in the database because
 * {@link ReceiversService.enable} replays it to BlindPay, but it must never be
 * serialized to a caller: a `kyc:read` key listing receivers would otherwise get back
 * the whole KYC dossier of every person the tenant ever onboarded, a field the OpenAPI
 * spec does not even admit exists. This is a `select` rather than a delete-after-read
 * so the dossier never leaves PostgreSQL in the first place.
 */
export const RECEIVER_PUBLIC_SELECT = {
  id: true,
  blindpayId: true,
  type: true,
  kycType: true,
  kycStatus: true,
  email: true,
  name: true,
  country: true,
  externalId: true,
  disabled: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BlindpayReceiverSelect;

/** A receiver as returned to API callers: the row minus the KYC dossier (`raw`). */
export type PublicReceiver = Prisma.BlindpayReceiverGetPayload<{
  select: typeof RECEIVER_PUBLIC_SELECT;
}>;

/**
 * Whether the caller may act on a receiver as the platform rather than as its tenant.
 *
 * There is exactly one notion of privilege in this service and this is it: the role
 * APISIX forwards from the consumer's own metadata (`X-Consumer-Role`), which
 * `PermissionsGuard` already treats as full access. The platform-admin surface
 * (`/v1/admin`, `AdminGuard` + Bearer credentials) is the other, stronger identity and
 * has its own audited variants of these operations — see {@link ReceiversService.approveById}.
 *
 * A plain `kyc:write` key is NOT elevated: it belongs to the tenant whose KYC data is
 * under review, so it can neither sign off on that review nor lift an operator's
 * kill-switch.
 */
export function isElevatedConsumer(consumer: GatewayConsumer): boolean {
  return consumer.role === 'admin';
}

/**
 * Manages BlindPay receivers (the KYC/KYB entities) on behalf of a consumer.
 * Creates/updates go to BlindPay and are mirrored locally; reads come from the
 * mirror, with single-receiver reads refreshed from BlindPay so the KYC status
 * is current. Every row is scoped to the calling consumer.
 */
@Injectable()
export class ReceiversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Creates a receiver. We don't call BlindPay yet (it needs an accepted `tos_id`, and
   * the terms are only sent after our review). The lifecycle lives in `kycStatus`:
   *   inactive       → only the registration request exists (no KYC data yet)
   *   pending_review → KYC data uploaded, awaiting OUR (owner/admin) review
   *   pending_user   → we approved it; the customer must accept BlindPay's terms
   *   <BlindPay's>   → once the customer accepts, the receiver is created at BlindPay
   *                    and `kycStatus` becomes BlindPay's own (verifying/approved/…)
   * A create that carries KYC data lands in `pending_review`; a bare registration in
   * `inactive`. The full payload is stored so {@link enable} can replay it to BlindPay.
   */
  async create(consumer: GatewayConsumer, dto: CreateReceiverDto) {
    const local = await this.consumers.resolve(consumer);
    return this.prisma.blindpayReceiver.create({
      data: {
        consumerId: local.id,
        // Placeholder until the real `re_...` id is assigned on enable().
        blindpayId: `${LOCAL_RECEIVER_PREFIX}${randomUUID()}`,
        type: dto.type,
        kycType: dto.kyc_type,
        kycStatus: hasKycData(dto) ? 'pending_review' : 'inactive',
        email: dto.email,
        name: receiverName(dto),
        country: dto.country,
        externalId: dto.external_id ?? null,
        // Keep the full create payload so enable() can replay it to BlindPay.
        raw: toJson({ ...dto }),
      },
      // Never echo the stored dossier back — see RECEIVER_PUBLIC_SELECT.
      select: RECEIVER_PUBLIC_SELECT,
    });
  }

  /**
   * OUR review gate: an elevated caller signs off on a `pending_review` receiver. Only
   * then do we send the customer BlindPay's terms-of-service link. Moves the receiver to
   * `pending_user` and returns the hosted ToS url + email so the caller delivers it. The
   * real KYC approval still comes from BlindPay afterwards.
   *
   * The elevation check is HERE, not upstream. This is a public API route, so "the
   * dashboard is the only caller" was never an invariant this service could hold: one
   * `kyc:write` key could create a receiver (→ `pending_review`), approve its own KYC
   * payload (→ `pending_user`) and enable it, and a live identity would reach a regulated
   * provider without any second party ever having looked at it. A tenant key now gets a
   * 403 and the review has to happen through an elevated key or the audited platform
   * route (`POST /v1/admin/receivers/:id/approve` → {@link approveById}).
   */
  async approve(
    consumer: GatewayConsumer,
    id: string,
    redirectUrl: string,
  ): Promise<{
    receiver: PublicReceiver;
    url: string;
    email: string | null;
  }> {
    if (!isElevatedConsumer(consumer)) {
      throw ApiError.forbidden(
        ApiErrorCode.KycReviewRequired,
        'Approving a receiver requires an elevated (admin) key: the KYC review must be signed off by someone other than the key that submitted it.',
      );
    }
    const local = await this.consumers.resolve(consumer);
    // Ownership check (404 if the receiver isn't this consumer's) then the shared logic.
    await this.findReceiverOrThrow(local.id, id);
    assertRedirectAllowed(
      consumer.username,
      redirectUrl,
      this.redirectWhitelist(),
    );
    return this.approveById(id, redirectUrl);
  }

  /**
   * Approve a receiver BY LOCAL ID across any consumer — the platform-admin (owner)
   * variant of {@link approve}. Skips consumer scoping AND the elevation check, so both
   * callers must authorize first: `AdminController` via the AdminGuard, {@link approve}
   * via {@link isElevatedConsumer} plus its ownership check.
   * When `audit` is provided, the local status write and the audit row commit together.
   */
  async approveById(
    id: string,
    redirectUrl: string,
    audit?: AdminAuditData,
  ): Promise<{
    receiver: PublicReceiver;
    url: string;
    email: string | null;
  }> {
    const row = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
    });
    if (!row) throw ApiError.notFound('Receiver not found');
    assertTransition(row.kycStatus, 'pending_user');
    // BlindPay side-effect cannot join the DB transaction; local write + audit can.
    await this.assertRedirectForReceiver(row.consumerId, redirectUrl);
    const url = await this.tosUrl(redirectUrl, row);
    return this.prisma.$transaction(async (tx) => {
      // Compare-and-swap on the status we validated above: the read, the BlindPay call
      // and this write are not atomic, so a concurrent approve/edit could have moved the
      // receiver in between (e.g. back to pending_review after a KYC edit). Matching on
      // the old status means only one of the racing callers wins.
      const claimed = await tx.blindpayReceiver.updateMany({
        where: { id: row.id, kycStatus: row.kycStatus },
        data: { kycStatus: 'pending_user', tosSentAt: new Date() },
      });
      if (claimed.count === 0) {
        throw ApiError.conflict(
          ApiErrorCode.KycStateInvalid,
          'Receiver status changed while it was being approved; re-read it and retry.',
        );
      }
      const receiver = await tx.blindpayReceiver.findUniqueOrThrow({
        where: { id: row.id },
        select: RECEIVER_PUBLIC_SELECT,
      });
      if (audit) {
        await recordAuditInTransaction(tx, audit);
      }
      return { receiver, url, email: row.email };
    });
  }

  /** Requests BlindPay's hosted ToS acceptance url for a receiver. */

  private redirectWhitelist() {
    return this.config.get('kyc', { infer: true }).redirectUrlWhitelist;
  }

  private async assertRedirectForReceiver(
    consumerId: string,
    redirectUrl: string,
  ): Promise<void> {
    const consumer = await this.prisma.consumer.findUnique({
      where: { id: consumerId },
      select: { apisixUsername: true },
    });
    if (!consumer) {
      throw ApiError.notFound('Receiver consumer not found');
    }
    assertRedirectAllowed(
      consumer.apisixUsername,
      redirectUrl,
      this.redirectWhitelist(),
    );
  }

  private async tosUrl(
    redirectUrl: string,
    row: BlindpayReceiver,
  ): Promise<string> {
    const isLocal = row.blindpayId.startsWith(LOCAL_RECEIVER_PREFIX);
    const { url } = await this.blindpay.post<{ url: string }>(
      `/e/instances/${this.blindpay.instanceId}/tos`,
      {
        idempotency_key: randomUUID(),
        // Only reference an existing BlindPay receiver; a brand-new (local) one has none.
        receiver_id: isLocal ? null : row.blindpayId,
        redirect_url: redirectUrl,
      },
    );
    return url;
  }

  /**
   * Returns a terms-of-service acceptance link for a receiver (BlindPay's hosted
   * flow). The end user accepts it and is redirected back with a `tos_id` that
   * {@link enable} then submits. `channel: 'email'` records the send so it can't be
   * triggered more than once per day; the actual email is sent by the caller (the
   * dashboard) using the returned url + the receiver's email.
   */
  async requestTos(
    consumer: GatewayConsumer,
    id: string,
    dto: RequestTosDto,
    cooldownMs?: number,
  ): Promise<{ url: string; email: string | null; channel: 'code' | 'email' }> {
    const local = await this.consumers.resolve(consumer);
    // Ownership check (404 if the receiver isn't this consumer's) then the shared logic.
    await this.findReceiverOrThrow(local.id, id);
    assertRedirectAllowed(
      consumer.username,
      dto.redirect_url,
      this.redirectWhitelist(),
    );
    // The cooldown exists to cap how often we mail a KYC subject, so only a caller this
    // service can actually verify as privileged may shorten it. A request header alone
    // never qualifies: the gateway's header-remove list is the only thing standing
    // between a client-sent `X-Cosmos-Internal: 1` and a zero-cooldown mail loop, and it
    // is configuration this repository cannot check. An ordinary tenant key therefore
    // always gets the 24h default, whatever headers it sends.
    const cooldown = isElevatedConsumer(consumer) ? cooldownMs : undefined;
    return this.requestTosById(id, dto, cooldown);
  }

  /**
   * Resend the terms-of-service link for a receiver BY LOCAL ID across any consumer — the
   * platform-admin (owner) variant of {@link requestTos}. Skips consumer scoping; the
   * AdminGuard authorizes it. Same gate as the org-scoped path: the receiver must be
   * `pending_user`. The email channel is rate-limited; the default is once per day.
   *
   * `cooldownMs` shortens that limit (owners resend immediately, admins every minute) and
   * is a PRIVILEGED argument: it is honoured exactly as given, so every caller must have
   * established privilege first — `AdminController` behind `AdminGuard` (an authenticated
   * admin principal), or {@link requestTos}, which drops the value unless the gateway
   * consumer is elevated. Nothing here re-derives it from a header.
   * When `audit` is provided, any local write and the audit row commit together.
   */
  async requestTosById(
    id: string,
    dto: RequestTosDto,
    cooldownMs?: number,
    audit?: AdminAuditData,
  ): Promise<{ url: string; email: string | null; channel: 'code' | 'email' }> {
    const row = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
    });
    if (!row) throw ApiError.notFound('Receiver not found');
    // Terms are only (re)sent after our owner/admin review has approved the receiver.
    if (row.kycStatus !== 'pending_user') {
      throw ApiError.badRequest(
        ApiErrorCode.KycStateInvalid,
        'Terms of service can only be sent after the receiver has been approved.',
      );
    }
    const channel = dto.channel ?? 'code';
    const cooldown =
      cooldownMs !== undefined && Number.isFinite(cooldownMs) && cooldownMs >= 0
        ? cooldownMs
        : TOS_EMAIL_COOLDOWN_MS;

    if (
      channel === 'email' &&
      cooldown > 0 &&
      row.tosSentAt &&
      Date.now() - row.tosSentAt.getTime() < cooldown
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'A terms-of-service email was already sent for this receiver recently. Please wait before resending.',
      );
    }

    // BlindPay side-effect first; local write + audit are transactional.
    await this.assertRedirectForReceiver(row.consumerId, dto.redirect_url);
    const url = await this.tosUrl(dto.redirect_url, row);

    return this.prisma.$transaction(async (tx) => {
      if (channel === 'email') {
        // Re-assert the status AND the cooldown in the WHERE clause. The checks above
        // ran before the BlindPay round-trip, so two concurrent resends can both reach
        // this point; only the one whose UPDATE still matches an un-mailed row wins,
        // which is what actually caps the KYC subject's inbox at one mail per window.
        const sent = await tx.blindpayReceiver.updateMany({
          where: {
            id: row.id,
            kycStatus: 'pending_user',
            ...(cooldown > 0
              ? {
                  OR: [
                    { tosSentAt: null },
                    { tosSentAt: { lte: new Date(Date.now() - cooldown) } },
                  ],
                }
              : {}),
          },
          data: { tosSentAt: new Date() },
        });
        if (sent.count === 0) {
          throw ApiError.conflict(
            ApiErrorCode.KycStateInvalid,
            'A terms-of-service email for this receiver was sent concurrently, or its status changed. Re-read the receiver and retry.',
          );
        }
      }
      if (audit) {
        await recordAuditInTransaction(tx, audit);
      }
      return { url, email: row.email, channel };
    });
  }

  /**
   * Activates an inactive receiver: replays the stored registration payload to
   * BlindPay together with the accepted `tos_id`, then upgrades the local row in
   * place (placeholder id → real `re_...` id, status → BlindPay's). Idempotent —
   * an already-active receiver is just refreshed.
   */
  async enable(consumer: GatewayConsumer, id: string, tosId: string) {
    const local = await this.consumers.resolve(consumer);
    // Ownership check (404 if not this consumer's) then the shared activation logic.
    await this.findReceiverOrThrow(local.id, id);
    return this.enableById(id, tosId);
  }

  /**
   * Activate a receiver BY LOCAL ID across any consumer — the platform-admin (owner)
   * variant of {@link enable}. Skips consumer scoping; the AdminGuard authorizes it.
   * When `audit` is provided, the placeholder→real id write and the audit row commit together.
   */
  async enableById(
    id: string,
    tosId: string,
    audit?: AdminAuditData,
  ): Promise<PublicReceiver> {
    const row = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
    });
    if (!row) throw ApiError.notFound('Receiver not found');

    if (!row.blindpayId.startsWith(LOCAL_RECEIVER_PREFIX)) {
      // Already created at BlindPay — nothing to do but return the current state.
      await this.refreshReceiver(row);
      if (audit) {
        await this.prisma.$transaction(async (tx) => {
          await recordAuditInTransaction(tx, audit);
        });
      }
      return this.publicById(row.id);
    }
    // The customer can only accept terms after our owner/admin review approved it.
    // Handoff target is BlindPay's typical first status; mirrorReceiver writes the real one.
    assertTransition(row.kycStatus, 'verifying');

    // Claim the transition BEFORE the provider call, not after it. This is the one
    // transition with an irreversible side-effect in the middle: a plain
    // check-then-POST-then-update lets two concurrent enables both pass the check, both
    // `POST /customers`, and the second write overwrite `blindpayId` — leaving a real,
    // orphaned KYC identity at the provider that this service no longer references.
    // Matching on the status and the placeholder id means exactly one caller proceeds.
    const claimed = await this.prisma.blindpayReceiver.updateMany({
      where: {
        id: row.id,
        kycStatus: row.kycStatus,
        blindpayId: row.blindpayId,
      },
      data: { kycStatus: 'verifying' },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict(
        ApiErrorCode.KycStateInvalid,
        'Receiver is already being activated or its status changed; re-read it and retry.',
      );
    }

    const payload = (row.raw ?? {}) as Record<string, unknown>;
    let created: BlindpayObject;
    try {
      created = await this.blindpay.post<BlindpayObject>(
        this.blindpay.instancePath('/customers'),
        { ...payload, tos_id: tosId },
      );
    } catch (err) {
      // The upstream create failed, so no identity exists there: release the claim so the
      // customer can retry. Guarded on the placeholder id + our own claimed status so a
      // late-arriving winner's row is never dragged backwards.
      await this.prisma.blindpayReceiver.updateMany({
        where: {
          id: row.id,
          kycStatus: 'verifying',
          blindpayId: row.blindpayId,
        },
        data: { kycStatus: row.kycStatus },
      });
      throw err;
    }

    // Point the placeholder row at the real id + audit in one transaction, then mirror.
    await this.prisma.$transaction(async (tx) => {
      await tx.blindpayReceiver.updateMany({
        where: { id: row.id, blindpayId: row.blindpayId },
        data: { blindpayId: asString(created.id) },
      });
      if (audit) {
        await recordAuditInTransaction(tx, audit);
      }
    });
    await this.sync.mirrorReceiver(row.consumerId, created);
    return this.publicById(row.id);
  }

  /**
   * Re-read a receiver through {@link RECEIVER_PUBLIC_SELECT}.
   *
   * The mirror/sync service is shared with the admin surface and hands back the whole
   * row, `raw` included, so the read paths re-select instead of stripping keys off the
   * object in memory — the dossier stays in PostgreSQL.
   */
  private publicById(id: string): Promise<PublicReceiver> {
    return this.prisma.blindpayReceiver.findUniqueOrThrow({
      where: { id },
      select: RECEIVER_PUBLIC_SELECT,
    });
  }

  /** Refresh a receiver row from BlindPay (mirror), falling back to the local row. */
  private async refreshReceiver(row: BlindpayReceiver) {
    if (row.blindpayId.startsWith(LOCAL_RECEIVER_PREFIX)) return row;
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
      return await this.sync.mirrorReceiver(row.consumerId, fresh);
    } catch {
      return row;
    }
  }

  async findAll(consumer: GatewayConsumer, query: PaginationQueryDto) {
    const local = await this.consumers.resolve(consumer);
    const where = { consumerId: local.id };
    // `total` is the row count, not the page length — the two only coincide while no
    // pagination is applied, and a client paging on it would silently stop early.
    const [data, total] = await Promise.all([
      this.prisma.blindpayReceiver.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: RECEIVER_PUBLIC_SELECT,
      }),
      this.prisma.blindpayReceiver.count({ where }),
    ]);
    return page(data, total, query);
  }

  /**
   * Reads a receiver, refreshing it from BlindPay so the caller sees the latest
   * KYC status. Falls back to the local mirror if the provider call fails.
   */
  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PublicReceiver> {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findPublicOrThrow(local.id, id);
    // An inactive (local-only) receiver has no BlindPay record to refresh from yet.
    if (row.blindpayId.startsWith(LOCAL_RECEIVER_PREFIX)) {
      return row;
    }
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
      await this.sync.mirrorReceiver(local.id, fresh);
      return await this.publicById(row.id);
    } catch {
      return row;
    }
  }

  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdateReceiverDto,
  ): Promise<PublicReceiver> {
    const local = await this.consumers.resolve(consumer);
    // The full row (including `raw`) is needed here to merge the patch into the stored
    // create payload; only the response is narrowed.
    const row = await this.findReceiverOrThrow(local.id, id);
    // The accepted terms-of-service id is set once, at enable() time, and can NEVER be
    // changed afterwards — otherwise a validated receiver's ToS acceptance could be
    // forged. Strip it from any update so it's immutable post-validation.
    const patch: Record<string, unknown> = { ...dto };
    delete patch.tos_id;

    // Local-only receivers (inactive / pending_review / pending_user) do not exist at
    // BlindPay yet — merge into the stored create payload instead of PUTting upstream.
    if (row.blindpayId.startsWith(LOCAL_RECEIVER_PREFIX)) {
      const merged: Record<string, unknown> = {
        ...((row.raw ?? {}) as Record<string, unknown>),
        ...patch,
      };
      const mergedDto = merged as unknown as CreateReceiverDto;
      let kycStatus = row.kycStatus;
      // Any edit after our review gate must re-enter pending_review — otherwise a
      // kyc:write caller could mutate tax_id/docs post-approve and enable() would
      // POST never-reviewed data to BlindPay.
      if (row.kycStatus === 'pending_user' && Object.keys(patch).length > 0) {
        assertTransition(row.kycStatus, 'pending_review');
        kycStatus = 'pending_review';
      } else if (hasKycData(mergedDto) && row.kycStatus === 'inactive') {
        assertTransition(row.kycStatus, 'pending_review');
        kycStatus = 'pending_review';
      }
      return this.prisma.blindpayReceiver.update({
        where: { id: row.id },
        data: {
          raw: toJson(merged),
          name: receiverName(mergedDto),
          email: asNullableString(merged.email),
          country: asNullableString(merged.country),
          externalId: asNullableString(merged.external_id),
          kycStatus,
        },
        select: RECEIVER_PUBLIC_SELECT,
      });
    }

    const updated = await this.blindpay.put<BlindpayObject>(
      this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      patch,
    );
    // BlindPay PUT may return little; ensure we keep the id.
    await this.sync.mirrorReceiver(local.id, {
      id: row.blindpayId,
      ...updated,
    });
    return this.publicById(row.id);
  }

  /**
   * Deletes a receiver upstream and locally.
   *
   * Audited, like every other state-changing receiver operation. This is the most
   * destructive of them: it takes the receiver's terms-of-service acceptance evidence
   * (`tosSentAt`) and its KYC status with it, and the row is gone afterwards, so if the
   * deletion is not recorded here there is nothing left to reconstruct it from. The audit
   * row commits in the same transaction as the delete so the two cannot diverge, and it
   * carries only identifiers/status — never the KYC dossier itself.
   */
  async remove(consumer: GatewayConsumer, id: string, audit?: AdminAuditData) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    // Only delete at BlindPay if it was ever created there (inactive receivers are local-only).
    if (!row.blindpayId.startsWith(LOCAL_RECEIVER_PREFIX)) {
      await this.blindpay.delete(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
    }
    const entry: AdminAuditData = audit ?? {
      // No AdminPrincipal on the tenant path, so the actor is the API key APISIX
      // authenticated — the credential id when forwarded, else the consumer username.
      actorId: consumer.credentialId ?? consumer.username,
      actorRole: `api_key:${consumer.role ?? 'user'}`,
      action: 'receivers.delete',
      resourceType: 'receiver',
      resourceId: row.id,
      metadata: {
        blindpayId: row.blindpayId,
        kycStatus: row.kycStatus,
        consumerId: row.consumerId,
        tosSentAt: row.tosSentAt?.toISOString() ?? null,
        organizationId: consumer.organizationId,
      },
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.blindpayReceiver.delete({ where: { id: row.id } });
      await recordAuditInTransaction(tx, entry);
    });
    return { id, deleted: true };
  }

  /**
   * Owner/admin kill-switch: enable or disable this fiat account. A disabled receiver
   * can't be used for onramp/offramp (see {@link assertEnabled}); re-enabling restores
   * it. Independent of the BlindPay KYC status.
   *
   * Elevation is required here, not upstream. A kill-switch a tenant can flip back is
   * advisory: the very key an operator disabled the account away from could re-enable it
   * on the next request. Tenant keys get a 403; the audited platform variant is
   * `PATCH /v1/admin/receivers/:id/access`.
   */
  async setAccess(
    consumer: GatewayConsumer,
    id: string,
    disabled: boolean,
  ): Promise<PublicReceiver> {
    if (!isElevatedConsumer(consumer)) {
      throw ApiError.forbidden(
        ApiErrorCode.InsufficientScope,
        'Changing a fiat account kill-switch requires an elevated (admin) key.',
      );
    }
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    return this.prisma.blindpayReceiver.update({
      where: { id: row.id },
      data: { disabled },
      select: RECEIVER_PUBLIC_SELECT,
    });
  }

  /** Throws 403 when a receiver has been disabled — call before any fiat operation. */
  assertEnabled(receiver: { disabled: boolean }): void {
    if (receiver.disabled) {
      throw ApiError.forbidden(
        ApiErrorCode.AccountDisabled,
        'This fiat account is disabled. Re-enable it to use onramp/offramp.',
      );
    }
  }

  /**
   * Resolves a local receiver row for the consumer, or throws 404. Shared with
   * the wallet / bank-account / virtual-account services so a receiver id always
   * means "owned by this consumer".
   *
   * Returns the FULL row, `raw` (the KYC dossier) included, because callers need it
   * internally — `update()` merges into it, `enable()` replays it. Never hand the result
   * straight back to a client: use {@link findPublicOrThrow} / {@link publicById} for
   * anything that is serialized into a response.
   */
  async findReceiverOrThrow(
    consumerLocalId: string,
    id: string,
  ): Promise<BlindpayReceiver> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { id, consumerId: consumerLocalId },
    });
    if (!row) {
      throw ApiError.notFound('Receiver not found');
    }
    return row;
  }

  /**
   * Consumer-scoped read narrowed to {@link RECEIVER_PUBLIC_SELECT} — same 404 semantics
   * as {@link findReceiverOrThrow}, but the dossier is never fetched at all.
   */
  private async findPublicOrThrow(
    consumerLocalId: string,
    id: string,
  ): Promise<PublicReceiver> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { id, consumerId: consumerLocalId },
      select: RECEIVER_PUBLIC_SELECT,
    });
    if (!row) {
      throw ApiError.notFound('Receiver not found');
    }
    return row;
  }
}

/**
 * PARSE the dev platform's ToS email-resend cooldown headers — `X-Cosmos-Internal: 1`
 * marks the call as dashboard-internal and `X-Cosmos-Tos-Cooldown-Ms` carries the
 * role-derived value (owner → 0, admin → 60000). Returns undefined for a missing or
 * invalid pair, which means "use the 24h default".
 *
 * This function authorizes NOTHING. It used to document the headers as unforgeable
 * because APISIX strips them, but that is gateway configuration this repository cannot
 * verify — and a header that shortens a rate limit protecting a KYC subject's inbox must
 * not be the thing granting the privilege. Callers establish privilege first and only
 * then parse: `AdminController` runs behind `AdminGuard` (an authenticated admin
 * principal), and {@link ReceiversService.requestTos} discards the parsed value unless
 * {@link isElevatedConsumer} holds for the gateway consumer.
 */
export function resolveTosCooldownMs(
  internalHeader?: string | string[],
  cooldownHeader?: string | string[],
): number | undefined {
  const internal =
    (Array.isArray(internalHeader) ? internalHeader[0] : internalHeader) ===
    '1';
  if (!internal) return undefined;
  const raw = Array.isArray(cooldownHeader)
    ? cooldownHeader[0]
    : cooldownHeader;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Display name for a receiver from its create payload (business legal name or person). */
function receiverName(dto: CreateReceiverDto): string | null {
  if (dto.legal_name) return dto.legal_name;
  const full = [dto.first_name, dto.last_name].filter(Boolean).join(' ').trim();
  return full || null;
}

/**
 * True when a create payload carries actual KYC/KYB data (beyond the bare registration
 * basics) — used to decide whether the new receiver starts in `pending_review` (data
 * uploaded, awaiting our review) or `inactive` (registration request only).
 */
function hasKycData(dto: CreateReceiverDto): boolean {
  return Boolean(
    dto.tax_id ||
    dto.date_of_birth ||
    dto.id_doc_front_file ||
    dto.selfie_file ||
    dto.legal_name ||
    dto.formation_date ||
    (dto.owners && dto.owners.length > 0),
  );
}
