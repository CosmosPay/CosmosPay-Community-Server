import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ProtectedPayment,
  ProtectedPaymentStatus,
} from '@generated/prisma/client';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { AdminAuditService } from '@/admin/admin-audit.service';
import {
  ADMIN_CONSUMER_INCLUDE,
  adminSkip,
  adminTake,
  consumerWhere,
} from '@/admin/admin-list';
import { ApiError } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { toStroops } from '@/swaps/swap-math';
import {
  ProtectedPaymentActionsService,
  type SubmittedTransaction,
  type BuiltTransaction,
} from '@/native-plugins/trustless-work/protected-payment-actions.service';
import { merchantView } from '@/native-plugins/trustless-work/protected-payment-views';

const RESOURCE = 'protected_payment';

/**
 * The ops side of protected payments: the disputes to decide, and their
 * resolution. Behind the core's console-only `AdminGuard`, every mutation
 * audited with the console account that made it.
 *
 * A resolution may only ever pay the payment's own buyer and merchant, adding
 * up to the contract's balance (`checkedSplit` and the envelope check). Under
 * MANUAL_REVIEW the resolver is the ops wallet: the route answers the envelope
 * for it to sign, then the admin submit relays it. Under an auto policy the
 * resolver is the server's key, which signs and relays at once.
 */
@Injectable()
export class ProtectedPaymentsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ProtectedPaymentActionsService,
    private readonly audit: AdminAuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async list(opts: {
    consumer?: string;
    status?: ProtectedPaymentStatus;
    network?: string;
    take?: number;
    skip?: number;
  }) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.network ? { network: opts.network } : {}),
    };
    const take = adminTake(opts.take);
    const skip = adminSkip(opts.skip);
    const [rows, total] = await Promise.all([
      this.prisma.protectedPayment.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: 'desc' },
        include: ADMIN_CONSUMER_INCLUDE,
      }),
      this.prisma.protectedPayment.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        ...this.view(row),
        consumer: row.consumer,
      })),
      total,
      take,
      skip,
    };
  }

  async resolve(
    id: string,
    amounts: { buyerAmount: string; merchantAmount: string },
    actor: AdminPrincipal,
  ) {
    const row = await this.find(id);
    const outcome = await this.actions.resolve(
      row,
      {
        buyer: toStroops(amounts.buyerAmount),
        merchant: toStroops(amounts.merchantAmount),
      },
      actor.id,
    );
    await this.audit.record({
      actor,
      action: outcome.built
        ? 'protectedPayments.resolve.build'
        : 'protectedPayments.resolve',
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { ...amounts, network: row.network },
    });
    return {
      built: outcome.built ? this.builtView(outcome.built) : null,
      submitted: outcome.submitted
        ? this.submittedView(outcome.submitted)
        : null,
    };
  }

  /** Relays the ops wallet's signed resolution of this payment. */
  async submit(id: string, xdr: string, actor: AdminPrincipal) {
    const row = await this.find(id);
    if (!row.disputeResolverAddress) {
      throw ApiError.notFound(`Protected payment ${id} has no resolver`);
    }
    const submitted = await this.actions.submit(
      row,
      { signer: row.disputeResolverAddress, actions: ['RESOLVE'] },
      xdr,
    );
    await this.audit.record({
      actor,
      action: 'protectedPayments.resolve.submit',
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { txHash: submitted.txHash, status: submitted.status },
    });
    return this.submittedView(submitted);
  }

  private async find(id: string): Promise<ProtectedPayment> {
    const row = await this.prisma.protectedPayment.findUnique({
      where: { id },
    });
    if (!row) throw ApiError.notFound(`Protected payment ${id} not found`);
    return row;
  }

  private builtView(built: BuiltTransaction) {
    const { payment, ...rest } = built;
    return { ...rest, protectedPayment: this.view(payment) };
  }

  private submittedView(submitted: SubmittedTransaction) {
    const { payment, ...rest } = submitted;
    return { ...rest, protectedPayment: this.view(payment) };
  }

  private view(row: ProtectedPayment) {
    return merchantView(
      row,
      this.config.get('paymentIntents', { infer: true }).checkoutUrl,
    );
  }
}
