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
import {
  chainStateOf,
  chainSteps,
  type ChainState,
} from '@/native-plugins/trustless-work/protected-payment-chain-state';
import {
  ProtectedPaymentLifecycle,
  type StepData,
} from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import {
  type LifecycleStepName,
  OPEN_PROTECTED_PAYMENT_STATUSES,
} from '@/native-plugins/trustless-work/protected-payment-transitions';
import { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import {
  PROTECTED_PAYMENT_JOB_LOCK_TIMEOUT_MULTIPLIER,
  PROTECTED_PAYMENT_SYNC_INTERVAL_MS,
  PROTECTED_PAYMENT_SYNC_MAX_READS,
  TRUSTLESS_WORK_READ_BATCH,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

/**
 * Reads the open protected payments' contracts back through Trustless Work and
 * brings each row to what its contract shows. The chain is authoritative: the
 * submit routes only move a row optimistically when Trustless Work answers
 * SUCCESS, a party may act through Trustless Work's own tools, and nothing
 * notifies this service (Trustless Work has no webhooks), so it polls.
 *
 * Each cycle, per network that is configured: the open rows with a contract,
 * least recently read first, at most `PROTECTED_PAYMENT_SYNC_MAX_READS` reads of
 * `TRUSTLESS_WORK_READ_BATCH` contracts (the API's rate limit is shared with
 * every route). Every change is a step of `ProtectedPaymentLifecycle`, so it
 * emits its webhook once whoever saw it first.
 *
 * On with the settlement observer (`OBSERVER_ENABLED`), like the BlindPay
 * reconciler.
 */
@Injectable()
export class ProtectedPaymentSyncService extends ScheduledJob {
  protected readonly logger = new Logger(ProtectedPaymentSyncService.name);
  protected readonly lockKey = AdvisoryLockKey.ProtectedPaymentSync;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: TrustlessWorkClient,
    private readonly keys: TrustlessWorkKeys,
    private readonly lifecycle: ProtectedPaymentLifecycle,
    private readonly transactions: ProtectedPaymentTransactionsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    return {
      enabled: this.config.get('observer', { infer: true }).enabled,
      intervalMs: PROTECTED_PAYMENT_SYNC_INTERVAL_MS,
      description: 'Protected payment sync',
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
      await this.syncNetwork(network);
    }
  }

  /** One network's open contracts, least recently read first. */
  async syncNetwork(network: StellarNetwork): Promise<void> {
    const rows = await this.prisma.protectedPayment.findMany({
      where: {
        network,
        status: { in: [...OPEN_PROTECTED_PAYMENT_STATUSES] },
        contractId: { not: null },
      },
      orderBy: [{ lastSyncedAt: { sort: 'asc', nulls: 'first' } }],
      take: TRUSTLESS_WORK_READ_BATCH * PROTECTED_PAYMENT_SYNC_MAX_READS,
    });
    for (let i = 0; i < rows.length; i += TRUSTLESS_WORK_READ_BATCH) {
      const batch = rows.slice(i, i + TRUSTLESS_WORK_READ_BATCH);
      try {
        const reads = await this.client.contracts(
          network,
          batch.map((row) => row.contractId!),
        );
        const byId = new Map(
          reads
            .filter((read) => typeof read.contractId === 'string')
            .map((read) => [read.contractId!, read]),
        );
        for (const row of batch) {
          const read = byId.get(row.contractId!);
          if (read) await this.apply(row, chainStateOf(read));
        }
      } catch (err) {
        // Trustless Work down or rate limiting: the rest waits for the next
        // cycle, and this batch stays first in line.
        this.logger.warn(
          `Protected payment sync on ${network} stopped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      await this.prisma.protectedPayment.updateMany({
        where: { id: { in: batch.map((row) => row.id) } },
        data: { lastSyncedAt: new Date() },
      });
    }
  }

  /** Takes, in order, every step the contract shows and the row has not. */
  async apply(row: ProtectedPayment, state: ChainState): Promise<void> {
    for (const step of chainSteps(row, state)) {
      await this.lifecycle.step(
        row.id,
        step,
        await this.dataFor(row, step, state),
      );
    }
  }

  private async dataFor(
    row: ProtectedPayment,
    step: LifecycleStepName,
    state: ChainState,
  ): Promise<StepData> {
    if (step === 'FUNDED') {
      return {
        deliveryDeadlineAt: new Date(
          Date.now() + row.deliveryWindowHours * 3_600_000,
        ),
      };
    }
    if (step === 'SHIPPED') return { evidence: state.evidence };
    if (step === 'DISPUTED') {
      // Who opened it, when it went through this service: the newest dispute
      // relayed for it says so. A dispute opened elsewhere names nobody.
      const last = await this.transactions.latest(row.id, 'DISPUTE');
      const context =
        last && last.status !== 'BUILT' && last.context
          ? (last.context as { by?: unknown; reason?: unknown })
          : {};
      return {
        disputedBy: typeof context.by === 'string' ? context.by : null,
        disputeReason:
          typeof context.reason === 'string' ? context.reason : null,
      };
    }
    return {};
  }
}
