import { Injectable, OnModuleInit } from '@nestjs/common';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { AdminExtension, AdminExtensions } from '@/admin/admin-extensions';
import {
  ADMIN_CONSUMER_INCLUDE as consumerSelect,
  type AdminListOpts as ListOpts,
  adminSkip as skip,
  adminTake as take,
  consumerWhere,
  sumCounts as sum,
  tallyBy,
} from '@/admin/admin-list';
import { toAuditEntry } from '@/audit/audit-writer';
import { ApiError } from '@/common/errors/api-error';
import { ReceiversService } from '@/native-plugins/blindpay/kyc/receivers/receivers.service';
import { RequestTosDto } from '@/native-plugins/blindpay/kyc/receivers/dto/request-tos.dto';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The platform-admin (owner) half of the BlindPay plugin: cross-consumer reads of
 * the receivers, payins and payouts it mirrors, the global fiat review actions,
 * and its `fiat` section of `GET /v1/admin/summary`. It used to live in the core
 * `AdminService`, which is why the core admin module had to import KYC.
 */
@Injectable()
export class BlindpayAdminService implements AdminExtension, OnModuleInit {
  readonly key = 'fiat';

  constructor(
    private readonly prisma: PrismaService,
    private readonly receiversSvc: ReceiversService,
    private readonly extensions: AdminExtensions,
  ) {}

  onModuleInit(): void {
    this.extensions.register(this);
  }

  async summary(): Promise<Record<string, unknown>> {
    const [receiversByStatus, payinsByStatus, payoutsByStatus] =
      await Promise.all([
        this.prisma.blindpayReceiver.groupBy({
          by: ['kycStatus'],
          _count: { _all: true },
        }),
        this.prisma.payin.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.payout.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);
    const receivers = tallyBy(receiversByStatus, 'kycStatus');
    const payins = tallyBy(payinsByStatus, 'status');
    const payouts = tallyBy(payoutsByStatus, 'status');
    return {
      receivers: { total: sum(receivers), byStatus: receivers },
      payins: { total: sum(payins), byStatus: payins },
      payouts: { total: sum(payouts), byStatus: payouts },
    };
  }

  async countsByConsumer(
    consumerIds: string[],
  ): Promise<Map<string, Record<string, number>>> {
    const where = { consumerId: { in: consumerIds } };
    const [receivers, payins, payouts] = await Promise.all([
      this.prisma.blindpayReceiver.groupBy({
        by: ['consumerId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.payin.groupBy({
        by: ['consumerId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.payout.groupBy({
        by: ['consumerId'],
        where,
        _count: { _all: true },
      }),
    ]);
    const counts = new Map<string, Record<string, number>>(
      consumerIds.map((id) => [
        id,
        { blindpayReceivers: 0, payins: 0, payouts: 0 },
      ]),
    );
    const fold = (
      rows: { consumerId: string | null; _count: { _all: number } }[],
      field: string,
    ) => {
      for (const row of rows) {
        const entry = row.consumerId ? counts.get(row.consumerId) : undefined;
        if (entry) entry[field] = row._count._all;
      }
    };
    fold(receivers, 'blindpayReceivers');
    fold(payins, 'payins');
    fold(payouts, 'payouts');
    return counts;
  }

  /**
   * Platform-admin (owner) review of ANY pending receiver across consumers: approve it
   * (pending_review → pending_user) and return BlindPay's hosted terms url + the
   * customer's email so the dev platform sends the terms email. The org-scoped approve
   * only works for the owner's own org, so the global admin Fiat view needs this.
   * Local status write + audit row commit in one transaction.
   */
  async approveReceiver(
    id: string,
    redirectUrl: string,
    actor: AdminPrincipal,
    expectedVersion?: number,
  ) {
    return this.receiversSvc.approveById(
      id,
      redirectUrl,
      toAuditEntry(actor, 'receivers.approve', 'receiver', id, {
        redirect_url: redirectUrl,
        expected_version: expectedVersion ?? null,
      }),
      expectedVersion,
    );
  }

  /** Platform-admin activation of ANY receiver across consumers (post terms acceptance). */
  async enableReceiver(id: string, tosId: string, actor: AdminPrincipal) {
    return this.receiversSvc.enableById(
      id,
      tosId,
      toAuditEntry(actor, 'receivers.enable', 'receiver', id, {
        tos_id: tosId,
      }),
    );
  }

  /**
   * Platform-admin resend of the terms-of-service link for ANY receiver across consumers.
   * The customer accepting these terms is what kicks off BlindPay verification, so the global
   * Admin → Fiat view uses this to re-send the verification email for a pending_user receiver.
   * Returns the ToS url + customer email so the dev platform sends the email (we have no mailer).
   */
  async requestReceiverTos(
    id: string,
    dto: RequestTosDto,
    actor: AdminPrincipal,
    cooldownMs?: number,
  ) {
    return this.receiversSvc.requestTosById(
      id,
      dto,
      cooldownMs,
      toAuditEntry(actor, 'receivers.requestTos', 'receiver', id, {
        channel: dto.channel ?? 'code',
        redirect_url: dto.redirect_url,
      }),
    );
  }

  /**
   * Platform-admin fiat kill-switch across ANY consumer: enable/disable a receiver by id
   * without consumer scoping (the owner acts globally). Mirrors the per-org access toggle.
   *
   * The flag write and its audit row commit in one transaction inside
   * `ReceiversService.setAccessById` (issue #34 / Gitar review). The admin service used to
   * run that transaction itself, straight against the receiver table — the one admin
   * receiver action that bypassed the kyc module owning the row — so the kill-switch had
   * two implementations. Now, like approve/enable/requestTos, it only supplies the actor.
   *
   * The response is re-read afterwards in the admin shape (owning consumer attached),
   * which is what this route has always returned; `setAccessById` answers with the tenant
   * projection, which leaves out the attribution the console shows.
   */
  async setReceiverAccess(
    id: string,
    disabled: boolean,
    actor: AdminPrincipal,
  ) {
    await this.receiversSvc.setAccessById(
      id,
      disabled,
      toAuditEntry(actor, 'receivers.setAccess', 'receiver', id, {
        disabled,
      }),
    );
    const receiver = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
      include: consumerSelect,
      // Same reason the list queries omit it: `raw` is the provider's full
      // KYC dossier — tax id, address, bank credentials. Toggling a
      // receiver's access is an authorization change and has no business
      // returning the dossier as its 200 body, where it lands in the
      // operator's browser, any proxy log, and the admin audit trail's
      // response capture.
      omit: { raw: true },
    });
    // setAccessById already 404s a missing receiver; this only fires if it was deleted
    // between the committed toggle and this read.
    if (!receiver) throw ApiError.notFound('Receiver not found');
    return receiver;
  }

  async receivers(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await Promise.all([
      this.prisma.blindpayReceiver.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
        // The provider blob holds the full KYC dossier / bank credentials. Admin
        // operators need to see that a record EXISTS and its state, not to have
        // every tax id and IBAN on the platform streamed into a list response.
        omit: { raw: true },
      }),
      this.prisma.blindpayReceiver.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async payins(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await Promise.all([
      this.prisma.payin.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
        // The provider blob holds the full KYC dossier / bank credentials. Admin
        // operators need to see that a record EXISTS and its state, not to have
        // every tax id and IBAN on the platform streamed into a list response.
        //
        // `instructions` is omitted for exactly the same reason and was missed:
        // `pickInstructions` deliberately keeps `pse_tax_id`, `pse_full_name`,
        // `pse_document_type`, `clabe`, `cbu` and `blindpay_bank_details`, so
        // omitting only `raw` left the tax ids and IBANs one column over. The
        // owning tenant still gets them from GET /v1/onramp/payins/:id — they
        // are that payer's funding instructions — but a platform-wide admin list
        // has no need of them.
        omit: { raw: true, instructions: true },
      }),
      this.prisma.payin.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async payouts(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
        // The provider blob holds the full KYC dossier / bank credentials. Admin
        // operators need to see that a record EXISTS and its state, not to have
        // every tax id and IBAN on the platform streamed into a list response.
        omit: { raw: true },
      }),
      this.prisma.payout.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }
}
