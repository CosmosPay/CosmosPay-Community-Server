import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProtectedPayment } from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { ProtectedPaymentActionsService } from '@/native-plugins/trustless-work/protected-payment-actions.service';
import { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import { wholeBalanceTo } from '@/native-plugins/trustless-work/protected-payment-math';
import { DEADLINE_POLICY_BENEFICIARY } from '@/native-plugins/trustless-work/protected-payment-roles';
import { IN_DELIVERY_STATUSES } from '@/native-plugins/trustless-work/protected-payment-transitions';
import { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import {
  PROTECTED_PAYMENT_DEADLINE_INTERVAL_MS,
  PROTECTED_PAYMENT_JOB_BATCH,
  PROTECTED_PAYMENT_JOB_LOCK_TIMEOUT_MULTIPLIER,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

/** The deadline policies the server settles itself. */
const AUTO_POLICIES = ['REFUND_BUYER', 'RELEASE_MERCHANT'] as const;

/** Who decided a resolution the deadline job made. */
export const DEADLINE_DECIDER = 'DEADLINE';

/**
 * What happens when a funded protected payment's delivery deadline passes
 * before it was released, disputed or resolved. Three passes per cycle, each
 * idempotent across restarts because each is a step the row records:
 *
 *  1. **Mark.** `deadlinePassedAt` is set and `PROTECTED_PAYMENT_DEADLINE_PASSED`
 *     emitted, once, for every policy. Under MANUAL_REVIEW that is all: the
 *     parties may still approve, release or dispute, and ops resolves a dispute.
 *  2. **Dispute** (REFUND_BUYER, RELEASE_MERCHANT). The platform key opens a
 *     dispute (the contract lets only a dispute be split by the resolver), as a
 *     recorded transaction marked `by: DEADLINE`; an unsent one is reused.
 *  3. **Resolve** (same policies, disputes the deadline opened only). The
 *     automatic resolver key pays the whole balance to the buyer or to the
 *     merchant. A dispute a party opened is never resolved here: ops decides it
 *     through the admin route.
 *
 * On with the settlement observer (`OBSERVER_ENABLED`).
 */
@Injectable()
export class ProtectedPaymentDeadlineService extends ScheduledJob {
  protected readonly logger = new Logger(ProtectedPaymentDeadlineService.name);
  protected readonly lockKey = AdvisoryLockKey.ProtectedPaymentDeadline;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: TrustlessWorkClient,
    private readonly keys: TrustlessWorkKeys,
    private readonly lifecycle: ProtectedPaymentLifecycle,
    private readonly actions: ProtectedPaymentActionsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    return {
      enabled: this.config.get('observer', { infer: true }).enabled,
      intervalMs: PROTECTED_PAYMENT_DEADLINE_INTERVAL_MS,
      description: 'Protected payment deadlines',
    };
  }

  protected lockTimeoutMs(): number {
    return (
      this.client.timeoutMs * PROTECTED_PAYMENT_JOB_LOCK_TIMEOUT_MULTIPLIER
    );
  }

  protected async run(): Promise<void> {
    for (const network of ['testnet', 'public'] as const) {
      if (!this.keys.isConfigured(network)) continue;
      await this.markPassed(network);
      await this.disputeAuto(network);
      await this.resolveAuto(network);
    }
  }

  /** Pass 1: every policy. */
  async markPassed(network: StellarNetwork): Promise<void> {
    const rows = await this.prisma.protectedPayment.findMany({
      where: {
        network,
        status: { in: [...IN_DELIVERY_STATUSES] },
        deliveryDeadlineAt: { lt: new Date() },
        deadlinePassedAt: null,
      },
      orderBy: { deliveryDeadlineAt: 'asc' },
      take: PROTECTED_PAYMENT_JOB_BATCH,
    });
    for (const row of rows) {
      await this.guard(row, 'mark', () =>
        this.lifecycle.step(row.id, 'DEADLINE_PASSED'),
      );
    }
  }

  /** Pass 2: the platform opens the dispute an auto policy settles. */
  async disputeAuto(network: StellarNetwork): Promise<void> {
    const rows = await this.prisma.protectedPayment.findMany({
      where: {
        network,
        status: { in: [...IN_DELIVERY_STATUSES] },
        deadlinePassedAt: { not: null },
        deadlinePolicy: { in: [...AUTO_POLICIES] },
      },
      orderBy: { deadlinePassedAt: 'asc' },
      take: PROTECTED_PAYMENT_JOB_BATCH,
    });
    for (const row of rows) {
      await this.guard(row, 'dispute', () =>
        this.actions.platformDispute(row, { by: 'DEADLINE', reason: null }),
      );
    }
  }

  /** Pass 3: the automatic resolver settles the disputes the deadline opened. */
  async resolveAuto(network: StellarNetwork): Promise<void> {
    const rows = await this.prisma.protectedPayment.findMany({
      where: {
        network,
        status: 'DISPUTED',
        disputedBy: 'DEADLINE',
        deadlinePolicy: { in: [...AUTO_POLICIES] },
      },
      orderBy: { disputedAt: 'asc' },
      take: PROTECTED_PAYMENT_JOB_BATCH,
    });
    for (const row of rows) {
      const beneficiary = DEADLINE_POLICY_BENEFICIARY[row.deadlinePolicy];
      if (!beneficiary) continue;
      await this.guard(row, 'resolve', async () => {
        const balance = await this.actions.balanceOf(row);
        return this.actions.resolve(
          row,
          wholeBalanceTo(beneficiary, balance),
          DEADLINE_DECIDER,
        );
      });
    }
  }

  /** One row's failure is logged and does not stop the others. */
  private async guard(
    row: ProtectedPayment,
    pass: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.logger.warn(
        `Protected payment ${row.id}: deadline ${pass} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
