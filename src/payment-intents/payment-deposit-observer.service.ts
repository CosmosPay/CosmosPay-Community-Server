import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig } from '@/config/configuration';
import { CROSS_CHAIN_OPEN_STATUSES } from '@/cross-chain-swaps/cross-chain-swap-transitions';
import {
  CROSS_CHAIN_LOCK_TIMEOUT_MULTIPLIER,
  CROSS_CHAIN_OBSERVER_BATCH,
  CROSS_CHAIN_RESCUE_WINDOW_MS,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import { PaymentDepositsService } from '@/payment-intents/payment-deposits.service';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Mirrors the cross-chain route's view of every open payment deposit into its
 * row, and settles the payment link a deposit paid.
 *
 * The same work as `CrossChainSwapObserverService`, on its own table: each tick
 * takes the least recently checked open deposits (and EXPIRED ones for
 * {@link CROSS_CHAIN_RESCUE_WINDOW_MS} past their deadline, since a late
 * deposit is refunded and the row must say so), asks the route where each
 * stands, and hands the answer to `PaymentDepositsService.applyProviderStatus`.
 * Then it retries the settlement of deposits that SUCCEEDED while their intent
 * is still unsettled, for as long as the rescue window: a settlement that died
 * after the deposit's status moved is finished here, never lost.
 *
 * On with the other observers (`OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS`).
 */
@Injectable()
export class PaymentDepositObserverService extends ScheduledJob {
  protected readonly logger = new Logger(PaymentDepositObserverService.name);
  protected readonly lockKey = AdvisoryLockKey.PaymentDepositObserver;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly nearIntents: NearIntentsClient,
    private readonly deposits: PaymentDepositsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    return {
      enabled,
      intervalMs,
      description: 'Payment deposit observer (payments from any network)',
    };
  }

  /** Every call in a tick is a round trip to the route; see the constant. */
  protected lockTimeoutMs(): number {
    const { timeoutMs } = this.config.get('nearIntents', { infer: true });
    return timeoutMs * CROSS_CHAIN_LOCK_TIMEOUT_MULTIPLIER;
  }

  protected async run(): Promise<void> {
    const rescueSince = new Date(Date.now() - CROSS_CHAIN_RESCUE_WINDOW_MS);
    const rows = await this.prisma.paymentDeposit.findMany({
      where: {
        // Test-network deposits are the sandbox's (`SandboxDepositObserverService`).
        network: 'public',
        OR: [
          { status: { in: [...CROSS_CHAIN_OPEN_STATUSES] } },
          { status: 'EXPIRED', expiresAt: { gte: rescueSince } },
        ],
      },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
      take: CROSS_CHAIN_OBSERVER_BATCH,
    });
    for (const deposit of rows) {
      try {
        const status = await this.nearIntents.status(
          deposit.depositAddress,
          deposit.depositMemo,
        );
        await this.deposits.applyProviderStatus(deposit, status);
      } catch (err) {
        // One deposit's failure must not stop the batch; the next tick retries it.
        this.logger.error(
          `Deposit ${deposit.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Deposits the route paid out whose intent is still open: their settlement
    // did not finish (or the route's report did not hold up yet). No upstream
    // call, only the settlement again.
    const unsettled = await this.prisma.paymentDeposit.findMany({
      where: {
        network: 'public',
        status: 'SUCCEEDED',
        updatedAt: { gte: rescueSince },
        intent: { status: { in: ['PENDING', 'SUBMITTED', 'EXPIRED'] } },
      },
      orderBy: { updatedAt: 'asc' },
      take: CROSS_CHAIN_OBSERVER_BATCH,
    });
    for (const deposit of unsettled) {
      try {
        await this.deposits.settle(deposit);
      } catch (err) {
        this.logger.error(
          `Deposit ${deposit.id}: settling intent ${deposit.intentId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
