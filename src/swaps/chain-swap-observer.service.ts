import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OtherChain } from '@/chains/chains.constants';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { ChainSwapsService } from '@/swaps/chain-swaps.service';
import {
  CHAIN_SWAP_LANDING_WINDOW_MS,
  CHAIN_SWAP_OBSERVER_BATCH,
  CHAIN_SWAP_RESCUE_WINDOW_MS,
} from '@/swaps/swaps.constants';

/**
 * Settles Solana and Monad swaps against their chains, the way the settlement
 * observer does Stellar's against Horizon:
 *
 *   - **PENDING** past its expiry was never submitted in time → EXPIRED.
 *   - **SUBMITTED** → SUCCEEDED or FAILED on the chain's own verdict (a Solana
 *     signature status, an EVM receipt); unseen past
 *     {@link CHAIN_SWAP_LANDING_WINDOW_MS} → EXPIRED.
 *   - **EXPIRED** with a hash is still looked for during
 *     {@link CHAIN_SWAP_RESCUE_WINDOW_MS}, so one that landed late is
 *     promoted rather than left looking lost.
 *
 * Runs with the settlement observer (`OBSERVER_ENABLED`,
 * `OBSERVER_INTERVAL_MS`). The transition and its webhook are
 * `ChainSwapsService.settle`'s; this only decides which one.
 */
@Injectable()
export class ChainSwapObserverService extends ScheduledJob {
  protected readonly logger = new Logger(ChainSwapObserverService.name);
  protected readonly lockKey = AdvisoryLockKey.ChainSwapObserver;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly swaps: ChainSwapsService,
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
      description: 'Chain swap observer (Solana, Monad)',
    };
  }

  /** A tick is up to a batch of sequential RPC reads; budget for them. */
  protected lockTimeoutMs(): number {
    const slowest = Math.max(
      this.config.get('solana', { infer: true }).timeoutMs,
      this.config.get('monad', { infer: true }).timeoutMs,
    );
    return Math.max(slowest * 6, 120_000);
  }

  protected async run(): Promise<void> {
    const now = Date.now();
    const rows = await this.prisma.chainSwap.findMany({
      where: {
        OR: [
          { status: 'PENDING', expiresAt: { lte: new Date(now) } },
          { status: 'SUBMITTED' },
          {
            status: 'EXPIRED',
            txHash: { not: null },
            expiresAt: { gte: new Date(now - CHAIN_SWAP_RESCUE_WINDOW_MS) },
          },
        ],
      },
      include: { consumer: { select: { apisixUsername: true } } },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
      take: CHAIN_SWAP_OBSERVER_BATCH,
    });

    for (const { consumer, ...swap } of rows) {
      const username = consumer.apisixUsername;
      try {
        if (swap.status === 'PENDING' || !swap.txHash) {
          await this.swaps.settle(swap, username, 'EXPIRED');
          continue;
        }
        const chain = swap.chain as OtherChain;
        const outcome = await this.swaps.venue(chain).settlement(swap.txHash);
        if (outcome) {
          await this.swaps.settle(swap, username, outcome);
        } else if (
          swap.status === 'SUBMITTED' &&
          now > swap.expiresAt.getTime() + CHAIN_SWAP_LANDING_WINDOW_MS[chain]
        ) {
          await this.swaps.settle(swap, username, 'EXPIRED');
        } else {
          await this.swaps.touch(swap.id);
        }
      } catch (err) {
        // One swap's RPC failure must not stop the batch; the next tick retries.
        this.logger.error(
          `${swap.chain} swap ${swap.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
