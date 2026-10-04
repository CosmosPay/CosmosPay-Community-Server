import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarService } from '@/stellar/stellar.service';
import {
  TransactionSettlement,
  transactionSettlement,
} from '@/stellar/transaction-settlement';
import { LiquidityPoolsService } from '@/liquidity-pools/liquidity-pools.service';
import { LpCostBasisService } from '@/liquidity-pools/lp-cost-basis.service';
import { SwapsService } from '@/swaps/swaps.service';
import {
  SETTLEMENT_FAILED_LOOKBACK_MS,
  SETTLEMENT_FAILED_RECHECK_MAX_ROWS,
  SETTLEMENT_LOCK_MIN_TIMEOUT_MS,
  SETTLEMENT_LOCK_TIMEOUT_INTERVALS,
} from '@/observer/observer.constants';
import {
  InFlightRow,
  SettlementResource,
  liquiditySettlementResource,
  swapSettlementResource,
} from '@/observer/settlement-resources';

/** The tables a sweep reconciles, in the order it reconciles them. */
const SETTLEMENT_KINDS = ['swaps', 'liquidity'] as const;
type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

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
 * It also re-checks recently FAILED rows ({@link heal}), because FAILED is not
 * proof the transaction did not settle: a re-submission rejected `tx_bad_seq`
 * after the wallet broadcast the same envelope itself is exactly that case.
 *
 * Observer never emits webhooks itself. Terminal events are a consequence of
 * winning `finalizeSucceeded` / `finalizeFailed` on the domain service — the
 * same functions submit uses — so a parallel observer+submit race produces one
 * event, not two.
 *
 * **One sweep, at most one replica at a time.** APISIX load-balances across
 * every replica, every one runs this interval, and every one selects the *same*
 * rows — so N replicas meant N× the Horizon round-trips for identical work.
 * Nothing was written twice (the guarded `updateMany` compare-and-swap sees to
 * that), but Horizon rate-limits, and a request that hangs holds its share of
 * the budget while the other replicas keep spending it. {@link ScheduledJob}
 * takes the `SettlementObserver` advisory lock around each sweep, so exactly
 * one replica sweeps per interval and the losers wait for their next tick; its
 * running latch keeps a slow cycle from overlapping the next timer fire here.
 *
 * The lock is transaction-scoped (`pg_try_advisory_xact_lock`), so a pod that
 * crashes mid-sweep releases it with its transaction — there is no lease to
 * expire and no wedged lock to clear by hand. {@link lockTimeoutMs} is what
 * keeps that transaction from being held open by a hung Horizon call.
 */
@Injectable()
export class SettlementObserverService extends ScheduledJob {
  protected readonly logger = new Logger(SettlementObserverService.name);
  protected readonly lockKey = AdvisoryLockKey.SettlementObserver;

  /**
   * One adapter per table, over the injected domain services. Plain objects
   * rather than providers: each is a configured view of a service this class
   * already receives — which rows are in flight, who finalizes them, what the
   * log calls them — with no lifecycle of its own.
   */
  private readonly resources: Record<SettlementKind, SettlementResource>;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    liquidity: LiquidityPoolsService,
    swaps: SwapsService,
    private readonly basis: LpCostBasisService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
    this.resources = {
      swaps: swapSettlementResource(prisma, swaps),
      liquidity: liquiditySettlementResource(prisma, liquidity),
    };
  }

  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    return {
      enabled,
      intervalMs,
      description: enabled
        ? 'Settlement observer'
        : 'Settlement observer (OBSERVER_ENABLED=false)',
    };
  }

  /** See {@link SETTLEMENT_LOCK_TIMEOUT_INTERVALS}. */
  protected lockTimeoutMs(): number {
    const { intervalMs } = this.config.get('observer', { infer: true });
    return Math.max(
      intervalMs * SETTLEMENT_LOCK_TIMEOUT_INTERVALS,
      SETTLEMENT_LOCK_MIN_TIMEOUT_MS,
    );
  }

  protected async run(): Promise<void> {
    const { batchSize } = this.config.get('observer', { infer: true });
    for (const kind of SETTLEMENT_KINDS) {
      await this.reconcile(kind, batchSize);
    }
    for (const kind of SETTLEMENT_KINDS) {
      await this.heal(kind);
    }
    await this.backfillDepositBasis(batchSize);
  }

  /**
   * Settles one table's in-flight rows from what Horizon says about their
   * hashes.
   *
   * One Horizon lookup per txHash. Historical duplicate hashes (pre-migration)
   * must not mint multiple SUCCEEDED / FAILED events for one on-chain tx — nor,
   * for liquidity pools, multiple cost bases for one deposit, which is why the
   * phantom rows take the `…Quiet` finalizers.
   */
  private async reconcile(
    kind: SettlementKind,
    batchSize: number,
  ): Promise<void> {
    const { label, transitions } = this.resources[kind];
    const rows = await this.resources[kind].selectInFlight(batchSize);
    const now = new Date();

    // Keyed by (network, txHash), not txHash alone: that is the pair the
    // unique constraint enforces, so a hash is only unique *within* a network.
    // Grouping on the hash alone would put a testnet row and a public row in
    // one bucket and then settle both from a single Horizon lookup against
    // whichever network happened to sort first — deciding a mainnet swap's fate
    // from a testnet ledger.
    const byHash = new Map<string, InFlightRow[]>();
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
            const { applied } = await transitions.finalizeSucceeded(
              row.id,
              row.consumer.apisixUsername,
            );
            if (applied) {
              this.logger.log(`Reconciled ${label} ${row.id} → SUCCEEDED`);
            }
          } else {
            // Duplicate hash: settle the phantom row without a second webhook.
            const { applied } = await transitions.finalizeSucceededQuiet(
              row.id,
            );
            if (applied) {
              this.logger.log(
                `Reconciled duplicate-hash ${label} ${row.id} → SUCCEEDED (no webhook)`,
              );
            }
          }
        }
      } else if (settlement === 'failed') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          if (i === 0) {
            const { applied } = await transitions.finalizeFailed(
              row.id,
              row.consumer.apisixUsername,
            );
            if (applied) {
              this.logger.warn(`Reconciled ${label} ${row.id} → FAILED`);
            }
          } else {
            const { applied } = await transitions.finalizeFailedQuiet(row.id);
            if (applied) {
              this.logger.warn(
                `Reconciled duplicate-hash ${label} ${row.id} → FAILED (no webhook)`,
              );
            }
          }
        }
      } else if (settlement === 'absent') {
        // Reached only when Horizon positively answered "not on-chain".
        for (const row of group) {
          if (row.expiresAt && row.expiresAt < now) {
            const { applied } = await transitions.finalizeExpired(row.id);
            if (applied) {
              this.logger.log(`Expired ${label} ${row.id} (never settled)`);
            }
          }
        }
      }
    }
  }

  /**
   * Promotes FAILED rows whose transaction the ledger shows settled.
   *
   * Only the `succeeded` verdict acts: a FAILED row cannot be failed again or
   * expired (both are guarded on the in-flight statuses), and a 404 is what a
   * genuinely rejected transaction looks like. The promotion goes through the
   * same `finalizeSucceeded` the in-flight sweep and `submit` use — FAILED is
   * in both tables' can-succeed set — so a deposit captures its cost basis on
   * the way, and the compare-and-swap leaves exactly one writer to announce it.
   *
   * That announcement is delivered, not deduplicated away. The terminal emitter
   * keys its claim on `type:id:settlementEpoch`, and a correction keeps the
   * epoch of the attempt it corrects, so `…_SUCCEEDED:id:N` is a key the
   * earlier `…_FAILED:id:N` never claimed. The integrator sees FAILED, then
   * SUCCEEDED, for the same attempt — and SUCCEEDED is absorbing, so nothing
   * follows it. No row here shares its hash with another: both tables are
   * unique on `(network, txHash)`, and the duplicates that predate that sit
   * far outside the window.
   */
  private async heal(kind: SettlementKind): Promise<void> {
    const { label, transitions } = this.resources[kind];
    const since = new Date(Date.now() - SETTLEMENT_FAILED_LOOKBACK_MS);
    const rows = await this.resources[kind].selectRecentlyFailed(
      SETTLEMENT_FAILED_RECHECK_MAX_ROWS,
      since,
    );

    for (const row of rows) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      if (settlement !== 'succeeded') continue;
      const { applied } = await transitions.finalizeSucceeded(
        row.id,
        row.consumer.apisixUsername,
      );
      if (applied) {
        this.logger.warn(
          `Healed ${label} ${row.id} FAILED → SUCCEEDED (settled on-chain)`,
        );
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
      await this.basis.captureDepositBasis(op);
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

  /** See {@link transactionSettlement}; shared with the relay. */
  private settlementOf(
    network: string,
    txHash: string,
  ): Promise<TransactionSettlement> {
    return transactionSettlement(this.stellar, network, txHash, this.logger);
  }
}
