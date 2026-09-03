import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarService } from '@/stellar/stellar.service';
import { LiquidityPoolsService } from '@/liquidity-pools/liquidity-pools.service';
import { SwapsService } from '@/swaps/swaps.service';

/** On-chain settlement of a stored transaction, keyed by its hash. */
/**
 * What the chain says about a transaction.
 *
 * `absent` and `unknown` must stay distinct. They used to be one value
 * (`unsettled`), which meant "Horizon returned 404" and "we could not reach
 * Horizon" were indistinguishable — and the expiry branch acted on both. A
 * transaction that had settled on-chain and paid the platform its commission
 * was marked EXPIRED during a Horizon outage, and since the observer only
 * selects PENDING/SUBMITTED rows it was never looked at again. There is no
 * recovery path from that state: the terminal statuses exclude EXPIRED, so no
 * webhook can still fire, and submit() rejects a retry.
 */
type Settlement = 'succeeded' | 'failed' | 'absent' | 'unknown';

/**
 * Permanent settlement observer for swaps and liquidity pool operations. Both
 * are non-custodial: the customer signs and broadcasts the transaction we built,
 * and may do so **without** calling our submit endpoint (e.g. straight from their
 * wallet via the SEP-7 link). Signing does not change the transaction hash, so on
 * a fixed interval we look each PENDING/SUBMITTED row up on Horizon **by its
 * stored txHash** and finalize it — SUCCEEDED / FAILED (with the matching webhook
 * event) or EXPIRED once its timebounds lapse. Mirrors the payment-intent
 * observer; polling survives restarts with no cursor bookkeeping.
 *
 * Observer never emits webhooks itself. Terminal events are a consequence of
 * winning `finalizeSucceeded` / `finalizeFailed` on the domain service — the
 * same functions submit uses — so a parallel observer+submit race produces one
 * event, not two.
 */
@Injectable()
export class SettlementObserverService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SettlementObserverService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly liquidity: LiquidityPoolsService,
    private readonly swaps: SwapsService,
    // Provided by the @Global() CommonModule in the running application.
    // `@Optional` so the unit tests, which construct this service by hand
    // rather than through the container, sweep unguarded — there is only one
    // of them, which is precisely the condition the lock enforces in prod.
    @Optional() private readonly locks?: AdvisoryLockService,
  ) {}

  onModuleInit(): void {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    if (!enabled) {
      this.logger.log('Settlement observer disabled (OBSERVER_ENABLED=false)');
      return;
    }
    this.logger.log(`Settlement observer started (every ${intervalMs}ms)`);
    // `unref` so the interval never keeps the process alive on its own.
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One sweep, at most one replica at a time.
   *
   * `running` is the in-process guard (a slow cycle must not overlap the next
   * timer fire). It says nothing about the other replicas: APISIX
   * load-balances across all of them, every one runs this interval, and every
   * one selects the *same* oldest rows — so N replicas meant N× the Horizon
   * round-trips for identical work. Nothing was written twice (the guarded
   * `updateMany` compare-and-swap sees to that), but Horizon rate-limits, and a
   * request that hangs holds its share of the budget while the other replicas
   * keep spending it. The advisory lock makes exactly one replica sweep per
   * interval; the losers return immediately and wait for their next tick.
   *
   * The lock is transaction-scoped (`pg_try_advisory_xact_lock`), so a pod that
   * crashes mid-sweep releases it with its transaction — there is no lease to
   * expire and no wedged lock to clear by hand. The bounded timeout is what
   * keeps that transaction from being held open by a hung Horizon call.
   */
  private async tick(): Promise<void> {
    if (this.running) return; // never overlap cycles
    this.running = true;
    try {
      const { batchSize, intervalMs } = this.config.get('observer', {
        infer: true,
      });
      const sweep = async () => {
        await this.reconcileSwaps(batchSize);
        await this.reconcileLiquidity(batchSize);
        await this.backfillDepositBasis(batchSize);
      };
      if (this.locks) {
        await this.locks.runExclusive(
          AdvisoryLockKey.SettlementObserver,
          sweep,
          Math.max(intervalMs * 4, 60_000),
        );
      } else {
        await sweep();
      }
    } catch (err) {
      this.logger.error('Settlement observer cycle failed', err as Error);
    } finally {
      this.running = false;
    }
  }

  // ── Swaps ────────────────────────────────────────────────────────────────
  private async reconcileSwaps(batchSize: number): Promise<void> {
    const rows = await this.prisma.swap.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    const now = new Date();

    // One Horizon lookup per txHash. Historical duplicate hashes (pre-migration)
    // must not mint multiple SWAP_SUCCEEDED / SWAP_FAILED for one on-chain tx.
    // Keyed by (network, txHash), not txHash alone: that is the pair the
    // unique constraint enforces, so a hash is only unique *within* a network.
    // Grouping on the hash alone would put a testnet row and a public row in
    // one bucket and then settle both from a single Horizon lookup against
    // whichever network happened to sort first — deciding a mainnet swap's fate
    // from a testnet ledger.
    const byHash = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.network}:${row.txHash}`;
      const group = byHash.get(key) ?? [];
      group.push(row);
      byHash.set(key, group);
    }

    for (const [, group] of byHash) {
      const primary = group[0];
      const settlement = await this.settlementOf(
        primary.network,
        primary.txHash,
      );

      if (settlement === 'succeeded') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          const username = row.consumer.apisixUsername;
          if (i === 0) {
            const { applied } = await this.swaps.finalizeSucceeded(
              row.id,
              username,
            );
            if (applied) {
              this.logger.log(`Reconciled swap ${row.id} → SUCCEEDED`);
            }
          } else {
            // Duplicate hash: settle the phantom row without a second webhook.
            const { applied } = await this.swaps.finalizeSucceededQuiet(row.id);
            if (applied) {
              this.logger.log(
                `Reconciled duplicate-hash swap ${row.id} → SUCCEEDED (no webhook)`,
              );
            }
          }
        }
      } else if (settlement === 'failed') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          const username = row.consumer.apisixUsername;
          if (i === 0) {
            const { applied } = await this.swaps.finalizeFailed(
              row.id,
              username,
            );
            if (applied) {
              this.logger.warn(`Reconciled swap ${row.id} → FAILED`);
            }
          } else {
            const { applied } = await this.swaps.finalizeFailedQuiet(row.id);
            if (applied) {
              this.logger.warn(
                `Reconciled duplicate-hash swap ${row.id} → FAILED (no webhook)`,
              );
            }
          }
        }
      } else if (settlement === 'absent') {
        // Reached only when Horizon positively answered "not on-chain".
        for (const row of group) {
          if (row.expiresAt && row.expiresAt < now) {
            const { applied } = await this.swaps.finalizeExpired(row.id);
            if (applied) {
              this.logger.log(`Expired swap ${row.id} (never settled)`);
            }
          }
        }
      }
    }
  }

  // ── Liquidity pool operations ──────────────────────────────────────────────
  private async reconcileLiquidity(batchSize: number): Promise<void> {
    const rows = await this.prisma.liquidityPoolOperation.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    const now = new Date();

    // One Horizon lookup per txHash, exactly as the swaps branch above.
    // Historical duplicate hashes (pre-migration) must not mint multiple
    // LIQUIDITY_SUCCEEDED / LIQUIDITY_FAILED for one on-chain tx — nor, here,
    // multiple cost bases for one deposit, which is why the phantom rows take
    // the `…Quiet` finalizers.
    // Keyed by (network, txHash), not txHash alone: that is the pair the
    // unique constraint enforces, so a hash is only unique *within* a network.
    // Grouping on the hash alone would put a testnet row and a public row in
    // one bucket and then settle both from a single Horizon lookup against
    // whichever network happened to sort first — deciding a mainnet swap's fate
    // from a testnet ledger.
    const byHash = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.network}:${row.txHash}`;
      const group = byHash.get(key) ?? [];
      group.push(row);
      byHash.set(key, group);
    }

    for (const [, group] of byHash) {
      const primary = group[0];
      const settlement = await this.settlementOf(
        primary.network,
        primary.txHash,
      );

      if (settlement === 'succeeded') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          if (i === 0) {
            const { applied } = await this.liquidity.finalizeSucceeded(
              row.id,
              row.consumer.apisixUsername,
            );
            if (applied) {
              this.logger.log(`Reconciled LP operation ${row.id} → SUCCEEDED`);
            }
          } else {
            const { applied } = await this.liquidity.finalizeSucceededQuiet(
              row.id,
            );
            if (applied) {
              this.logger.log(
                `Reconciled duplicate-hash LP operation ${row.id} → SUCCEEDED (no webhook)`,
              );
            }
          }
        }
      } else if (settlement === 'failed') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          if (i === 0) {
            const { applied } = await this.liquidity.finalizeFailed(
              row.id,
              row.consumer.apisixUsername,
            );
            if (applied) {
              this.logger.warn(`Reconciled LP operation ${row.id} → FAILED`);
            }
          } else {
            const { applied } = await this.liquidity.finalizeFailedQuiet(
              row.id,
            );
            if (applied) {
              this.logger.warn(
                `Reconciled duplicate-hash LP operation ${row.id} → FAILED (no webhook)`,
              );
            }
          }
        }
      } else if (settlement === 'absent') {
        // Reached only when Horizon positively answered "not on-chain".
        for (const row of group) {
          if (row.expiresAt && row.expiresAt < now) {
            const { applied } = await this.liquidity.finalizeExpired(row.id);
            if (applied) {
              this.logger.log(`Expired LP operation ${row.id} (never settled)`);
            }
          }
        }
      }
    }
  }

  /**
   * Re-attempts cost-basis capture for settled deposits that never got one.
   *
   * `captureDepositBasis` runs once, at the moment a deposit transitions to
   * SUCCEEDED, and is best-effort: a Horizon 429 or timeout leaves
   * `sharesReceived` NULL and returns. Nothing looked at that row again — the
   * reconcilers select only PENDING/SUBMITTED — so the miss was permanent, and
   * permanent is what turns it from a deferral into a revenue leak:
   * `aggregateCostBasis` skips a deposit with no basis, so those shares fall
   * outside `remainingShares`, and `computeWithdrawCommission` charges nothing
   * on the portion they cover. One Horizon incident silently forfeits the
   * commission on every position that settled during it.
   *
   * The capture is already idempotent — its UPDATE is guarded on
   * `sharesReceived: null` and `status: 'SUCCEEDED'` — so retrying is safe and
   * needs no new invariant. Rows whose effect genuinely has no
   * `liquidity_pool_deposited` (nothing to capture) are re-examined each cycle;
   * that costs one Horizon call per such row per tick, which the batch bound
   * caps.
   */
  private async backfillDepositBasis(batchSize: number): Promise<void> {
    const missing = await this.prisma.liquidityPoolOperation.findMany({
      where: { kind: 'DEPOSIT', status: 'SUCCEEDED', sharesReceived: null },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    if (missing.length === 0) return;

    let captured = 0;
    for (const op of missing) {
      const before = op.sharesReceived;
      await this.liquidity.captureDepositBasis(op);
      const after = await this.prisma.liquidityPoolOperation.findUnique({
        where: { id: op.id },
        select: { sharesReceived: true },
      });
      if (before == null && after?.sharesReceived != null) captured++;
    }
    if (captured > 0) {
      this.logger.log(
        `Backfilled the cost basis of ${captured} settled deposit(s)`,
      );
    }
  }

  /**
   * Looks a transaction up by its deterministic hash on Horizon. Because signing
   * does not change the hash, a customer who signs and broadcasts the tx
   * themselves (bypassing our submit endpoint) still settles under this hash. A
   * A 404 means it is simply not on-chain yet (`absent`). Any other Horizon
   * error is transient (`unknown`) and the row is left in flight for the next
   * cycle — crucially it is NOT eligible for expiry, because we did not manage
   * to ask the chain.
   */
  private async settlementOf(
    network: string,
    txHash: string,
  ): Promise<Settlement> {
    try {
      const tx = await this.stellar
        .server(network as StellarNetwork)
        .transactions()
        .transaction(txHash)
        .call();
      return tx.successful ? 'succeeded' : 'failed';
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      // Only a 404 is Horizon telling us the transaction is not on-chain. A
      // 429, a 504 or a socket timeout tells us nothing about the transaction
      // at all, and must never be read as "it never settled".
      if (status === 404) return 'absent';
      this.logger.warn(
        `Horizon lookup failed for tx ${txHash} (status ${status ?? 'none'}); ` +
          'leaving the operation in flight for the next cycle',
      );
      return 'unknown';
    }
  }
}
