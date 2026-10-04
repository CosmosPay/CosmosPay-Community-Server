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
import { CrossChainSwapsService } from '@/cross-chain-swaps/cross-chain-swaps.service';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Mirrors NEAR Intents' view of every open cross-chain swap into its row.
 *
 * Each tick takes the least recently checked open swaps — and EXPIRED ones for
 * {@link CROSS_CHAIN_RESCUE_WINDOW_MS} past their deadline, since a late deposit
 * is refunded and the row must say so — asks 1Click where each stands, and
 * hands the answer to {@link CrossChainSwapsService.applyProviderStatus}, which
 * owns the transition and its webhook. No wallet has to come back for a swap
 * to settle here: the payer can close the app the moment the deposit is sent.
 *
 * On with the settlement observer (`OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS`),
 * because it is the same kind of work — reconciling a row against a ledger this
 * service does not write.
 */
@Injectable()
export class CrossChainSwapObserverService extends ScheduledJob {
  protected readonly logger = new Logger(CrossChainSwapObserverService.name);
  protected readonly lockKey = AdvisoryLockKey.CrossChainSwapObserver;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly nearIntents: NearIntentsClient,
    private readonly swaps: CrossChainSwapsService,
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
      description: 'Cross-chain swap observer (NEAR Intents)',
    };
  }

  /** Every call in a tick is a 1Click round-trip; see the constant. */
  protected lockTimeoutMs(): number {
    const { timeoutMs } = this.config.get('nearIntents', { infer: true });
    return timeoutMs * CROSS_CHAIN_LOCK_TIMEOUT_MULTIPLIER;
  }

  protected async run(): Promise<void> {
    const rescueSince = new Date(Date.now() - CROSS_CHAIN_RESCUE_WINDOW_MS);
    const rows = await this.prisma.crossChainSwap.findMany({
      where: {
        OR: [
          { status: { in: [...CROSS_CHAIN_OPEN_STATUSES] } },
          { status: 'EXPIRED', expiresAt: { gte: rescueSince } },
        ],
      },
      include: { consumer: { select: { apisixUsername: true } } },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
      take: CROSS_CHAIN_OBSERVER_BATCH,
    });

    for (const { consumer, ...swap } of rows) {
      try {
        const status = await this.nearIntents.status(
          swap.depositAddress,
          swap.depositMemo,
        );
        await this.swaps.applyProviderStatus(
          swap,
          status,
          consumer.apisixUsername,
        );
      } catch (err) {
        // One swap's failure (1Click down for it, a row that will not write)
        // must not stop the rest of the batch; the next tick retries it.
        this.logger.error(
          `Cross-chain swap ${swap.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
