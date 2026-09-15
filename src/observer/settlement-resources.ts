import { PrismaService } from '@/prisma/prisma.service';
import { SETTLEMENT_MAX_ROWS_PER_CONSUMER } from '@/observer/observer.constants';

/** The columns the sweep reads off an in-flight row, whichever table it is in. */
export interface InFlightRow {
  id: string;
  network: string;
  txHash: string;
  expiresAt: Date | null;
  consumer: { apisixUsername: string };
}

/** The sweep needs only the verdict of a guarded transition, not the row. */
export interface TransitionVerdict {
  applied: boolean;
}

/**
 * The domain transitions the sweep drives. `SwapsService` and
 * `LiquidityPoolsService` both satisfy this as they stand — they differ only in
 * what they call the row they return, which the sweep never reads.
 */
export interface SettlementTransitions {
  finalizeSucceeded(id: string, username: string): Promise<TransitionVerdict>;
  finalizeSucceededQuiet(id: string): Promise<TransitionVerdict>;
  finalizeFailed(id: string, username: string): Promise<TransitionVerdict>;
  finalizeFailedQuiet(id: string): Promise<TransitionVerdict>;
  finalizeExpired(id: string): Promise<TransitionVerdict>;
}

/**
 * One table the settlement observer reconciles.
 *
 * The observer used to carry `reconcileSwaps` and `reconcileLiquidity` as two
 * line-for-line copies that differed in exactly these three things: which rows
 * are in flight, which service finalizes them, and the noun in the log line.
 * Everything else — one Horizon lookup per `(network, txHash)`, the quiet
 * finalizers for duplicate hashes, expiry only on a positive 404 — is the same
 * rule for both, and is written once in the observer.
 */
export interface SettlementResource {
  /** The noun in the sweep's log lines, e.g. `swap`. */
  label: string;
  /** This tick's in-flight rows, fairly dealt across consumers; see below. */
  selectInFlight(batchSize: number): Promise<InFlightRow[]>;
  transitions: SettlementTransitions;
}

/**
 * In-flight swaps: dealt round-robin across consumers, at most
 * {@link SETTLEMENT_MAX_ROWS_PER_CONSUMER} from any one of them.
 *
 * It used to be the oldest `batchSize` rows across every tenant, which let
 * whoever had the most rows in flight own every tick (see the constant for how
 * cheaply the shared public key arranges that). Ranking each consumer's rows
 * oldest-first and ordering by that rank hands out every consumer's oldest row
 * before anyone's second, so a quiet tenant is served on the next tick however
 * large the backlog in front of it.
 *
 * Lapsed rows are deliberately NOT filtered out, unlike the payment-intent
 * observer's equivalent query. Here a row may only be expired on a Horizon 404
 * (see the observer's `Settlement`), so a row past its timebounds still needs
 * its one lookup — it may well have settled before they closed.
 *
 * Prisma has no per-group limit, hence the window function. The rows are then
 * re-read through the client, still in flight, so no Horizon lookup is spent
 * on a row `submit` finalized between the two reads — it can no longer
 * settle — and the sweep keeps its typed row and consumer. Oldest first, as
 * before: the duplicate-hash grouping treats a group's first row as the one
 * that announces.
 *
 * The SQL is written out per table rather than templated on the table name: a
 * `$queryRaw` identifier cannot be a bound parameter, and splicing one in with
 * `Prisma.raw` is the kind of string-built SQL this codebase does not do.
 */
export function swapSettlementResource(
  prisma: PrismaService,
  swaps: SettlementTransitions,
): SettlementResource {
  return {
    label: 'swap',
    transitions: swaps,
    async selectInFlight(batchSize) {
      const ranked = await prisma.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM (
          SELECT "id",
                 "createdAt",
                 ROW_NUMBER() OVER (
                   PARTITION BY "consumerId" ORDER BY "createdAt", "id"
                 ) AS "rank"
          FROM "swap"
          WHERE "status" IN ('PENDING', 'SUBMITTED')
        ) AS "inflight"
        WHERE "rank" <= ${SETTLEMENT_MAX_ROWS_PER_CONSUMER}
        ORDER BY "rank", "createdAt", "id"
        LIMIT ${batchSize}
      `;
      if (ranked.length === 0) return [];
      return prisma.swap.findMany({
        where: {
          id: { in: ranked.map((row) => row.id) },
          status: { in: ['PENDING', 'SUBMITTED'] },
        },
        include: { consumer: true },
        orderBy: { createdAt: 'asc' },
      });
    },
  };
}

/** {@link swapSettlementResource}, for liquidity pool operations. */
export function liquiditySettlementResource(
  prisma: PrismaService,
  liquidity: SettlementTransitions,
): SettlementResource {
  return {
    label: 'LP operation',
    transitions: liquidity,
    async selectInFlight(batchSize) {
      const ranked = await prisma.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM (
          SELECT "id",
                 "createdAt",
                 ROW_NUMBER() OVER (
                   PARTITION BY "consumerId" ORDER BY "createdAt", "id"
                 ) AS "rank"
          FROM "liquidity_pool_operation"
          WHERE "status" IN ('PENDING', 'SUBMITTED')
        ) AS "inflight"
        WHERE "rank" <= ${SETTLEMENT_MAX_ROWS_PER_CONSUMER}
        ORDER BY "rank", "createdAt", "id"
        LIMIT ${batchSize}
      `;
      if (ranked.length === 0) return [];
      return prisma.liquidityPoolOperation.findMany({
        where: {
          id: { in: ranked.map((row) => row.id) },
          status: { in: ['PENDING', 'SUBMITTED'] },
        },
        include: { consumer: true },
        orderBy: { createdAt: 'asc' },
      });
    },
  };
}
