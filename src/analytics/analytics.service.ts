import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { formatNumericAmount, toCount } from '@/common/money';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { page } from '@/common/pagination';
import { resolveNetwork } from '@/common/stellar-network';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, type PaymentIntentStatus } from '@generated/prisma/client';
import {
  CHAIN_SWAP_OUTCOMES,
  CROSS_CHAIN_SWAP_OUTCOMES,
  DAY_MS,
  LIQUIDITY_OPERATION_OUTCOMES,
  SERIES_SWAP_KINDS,
  SWAP_OUTCOMES,
  USDT0_TRANSFER_OUTCOMES,
  type SeriesOutcome,
  type SeriesPeriod,
  type SeriesSwapKind,
} from '@/analytics/analytics.constants';
import { outcomeCase, statusIn } from '@/analytics/series-outcomes';
import {
  bucketKey,
  fillBuckets,
  seriesWindow,
} from '@/analytics/series-window';
import { formatUsd, valueRows, type SettledRow } from '@/analytics/usd-prices';
import { UsdPricesService } from '@/analytics/usd-prices.service';
import {
  isChain,
  MAX_TOKEN_DECIMALS,
  NATIVE_ASSET_CODES,
} from '@/chains/chains.constants';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';

/** The ticker a row is reported under: the chain's coin for `native`. */
function assetLabel(asset: string, chain: string): string {
  if (asset && asset !== 'native') return asset;
  return NATIVE_ASSET_CODES[isChain(chain) ? chain : 'stellar'];
}

/**
 * How many places a chain's summed amounts are reported with: Stellar's 7, or
 * the widest a token may have elsewhere — cutting a Monad sum at 7 would
 * report a different amount than was paid.
 */
function placesFor(chain: string): number {
  return chain === 'stellar' ? STELLAR_DECIMALS : MAX_TOKEN_DECIMALS;
}

/**
 * The same label in SQL, for the grouped aggregates: `native` is XLM on
 * Stellar, SOL on Solana, MON on Monad. Grouped together with `chain`, so SOL
 * never lands in XLM's row and a token of one name on two chains is two rows.
 * `Prisma.raw` over constants of our own, never over anything a caller sent.
 */
const ASSET_LABEL_SQL = Prisma.raw(`
  CASE WHEN "asset" IN ('', 'native') THEN
    CASE "chain"
      WHEN 'solana' THEN '${NATIVE_ASSET_CODES.solana}'
      WHEN 'monad' THEN '${NATIVE_ASSET_CODES.monad}'
      ELSE '${NATIVE_ASSET_CODES.stellar}'
    END
  ELSE "asset" END`);

/**
 * The consumer's settled payments on `network` per chain, asset AND issuer, for their USD value:
 * a code alone does not say which token it is (anyone can issue a USDC on Stellar). With `unit`
 * (the series) each row also carries its bucket, `date_trunc` of that unit; without, `bucket`
 * is null. The unit is one of SERIES_PERIODS, spliced in as SQL text by the caller.
 */
function settledAssetsSql(
  consumerId: string,
  network: string,
  from: Date | null,
  unit: Prisma.Sql | null,
): Prisma.Sql {
  const bucket = unit
    ? Prisma.sql`date_trunc(${unit}, "createdAt")`
    : Prisma.raw('NULL::timestamp');
  const window = from ? Prisma.sql`AND "createdAt" >= ${from}` : Prisma.empty;
  return Prisma.sql`
    SELECT ${bucket} AS bucket,
           "chain",
           ${ASSET_LABEL_SQL} AS asset,
           "assetIssuer" AS issuer,
           SUM("amount"::numeric) AS amount,
           COUNT(*) AS count
    FROM "payment_intent"
    WHERE "consumerId" = ${consumerId}
      AND "network" = ${network}
      AND "status" = 'SUCCEEDED'
      ${window}
    GROUP BY 1, 2, 3, 4`;
}

/** A row of `settledAssetsSql` as the driver returns it. */
interface SettledAssetSqlRow {
  bucket: Date | null;
  chain: string;
  asset: string;
  issuer: string | null;
  amount: string | null;
  count: bigint;
}

function settledRow(row: SettledAssetSqlRow): SettledRow {
  return {
    chain: row.chain,
    asset: row.asset,
    issuer: row.issuer,
    amount: row.amount,
    count: toCount(row.count),
  };
}

/**
 * The table each kind of swap lives in, with the table of outcomes its statuses map to. A
 * `Record` over `SERIES_SWAP_KINDS`, so a new kind does not compile until it names both.
 */
const SWAP_SOURCES: Record<
  SeriesSwapKind,
  { table: string; outcomes: Record<string, SeriesOutcome> }
> = {
  dex: { table: 'swap', outcomes: SWAP_OUTCOMES },
  chain: { table: 'chain_swap', outcomes: CHAIN_SWAP_OUTCOMES },
  crossChain: {
    table: 'cross_chain_swap',
    outcomes: CROSS_CHAIN_SWAP_OUTCOMES,
  },
  usdt0: { table: 'usdt0_transfer', outcomes: USDT0_TRANSFER_OUTCOMES },
};

/**
 * One row per swap the consumer made on `network` from `from` on, whichever table holds it:
 * its `kind`, `createdAt` and `outcome`. Each branch is scoped as the payments are (consumer,
 * network, window) and reached through its table's index that leads with `consumerId`. The kind
 * and table names are the constants above, spliced in as SQL text; the rest is bound.
 */
function swapRowsSql(
  consumerId: string,
  network: string,
  from: Date,
): Prisma.Sql {
  return Prisma.join(
    SERIES_SWAP_KINDS.map((kind) => {
      const { table, outcomes } = SWAP_SOURCES[kind];
      return Prisma.sql`
        SELECT ${Prisma.raw(`'${kind}'`)} AS "kind",
               "createdAt",
               ${outcomeCase(outcomes)} AS "outcome"
        FROM ${Prisma.raw(`"${table}"`)}
        WHERE "consumerId" = ${consumerId}
          AND "network" = ${network}
          AND "createdAt" >= ${from}`;
    }),
    ' UNION ALL ',
  );
}

/**
 * Read-only aggregates derived from the consumer's existing payment intents, swaps, liquidity
 * operations and webhook deliveries, with no separate analytics store. Powers the dashboard's
 * Overview, Balances, Customers and Logs views.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly consumers: ConsumerResolverService,
    private readonly usd: UsdPricesService,
  ) {}

  /** Mirror the APISIX consumer locally (and return null if it has no records yet). */
  private async resolveConsumerId(consumer: GatewayConsumer): Promise<string> {
    const local = await this.consumers.resolve(consumer);
    return local.id;
  }

  /**
   * Stellar network the caller is scoped to. Every payment metric is filtered by
   * it, so it MUST agree with the three services that write the rows
   * (payment-intents, swaps, liquidity-pools) — hence the shared helper.
   *
   * This used to be a local `environment === 'prod' ? 'public' : 'testnet'`,
   * which silently disagreed with them: the writers fall back to the configured
   * default network when the gateway forwards no environment, while this
   * returned `testnet`. With no environment header the dashboard read an empty
   * testnet while every intent had been written to the configured default.
   */
  private network(consumer: GatewayConsumer): string {
    return resolveNetwork(this.config, consumer);
  }

  // ── Overview summary ────────────────────────────────────────────────────────
  async summary(consumer: GatewayConsumer) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);

    // This used to `findMany` every intent for (consumer, network) — no `take`,
    // no date bound — and then reduce the array five separate times in JS. Node
    // is single-threaded, so one merchant with a year of history blocked every
    // other in-flight request while it reduced. All five reductions are now
    // aggregations in Postgres, each bounded by an index, and only the six rows
    // actually rendered are materialized.
    //
    // The reason these are `$queryRaw` rather than Prisma `groupBy`/`_sum`:
    // `amount` is a `String` column (Stellar amounts are exact decimal strings,
    // and storing them as text is deliberate), so summing requires a `::numeric`
    // cast that `_sum` cannot express.
    const since = new Date(Date.now() - 29 * DAY_MS);

    const [
      statusRows,
      volumeRows,
      seriesRows,
      payerRows,
      succeededRecent,
      settledRows,
      pricer,
    ] = await Promise.all([
      this.prisma.paymentIntent.groupBy({
        by: ['status'],
        where: { consumerId, network },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<
        {
          chain: string;
          asset: string;
          amount: string | null;
          count: bigint;
        }[]
      >`
          SELECT "chain",
                 ${ASSET_LABEL_SQL} AS asset,
                 SUM("amount"::numeric) AS amount,
                 COUNT(*)               AS count
          FROM "payment_intent"
          WHERE "consumerId" = ${consumerId}
            AND "network" = ${network}
            AND "status" = 'SUCCEEDED'
          GROUP BY 1, 2
        `,
      this.prisma.$queryRaw<
        { day: Date; count: bigint; volume: string | null }[]
      >`
          SELECT date_trunc('day', "createdAt") AS day,
                 COUNT(*)                       AS count,
                 SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED') AS volume
          FROM "payment_intent"
          WHERE "consumerId" = ${consumerId}
            AND "network" = ${network}
            AND "createdAt" >= ${since}
          GROUP BY 1
        `,
      this.prisma.$queryRaw<{ payers: bigint }[]>`
          SELECT COUNT(DISTINCT "source") AS payers
          FROM "payment_intent"
          WHERE "consumerId" = ${consumerId}
            AND "network" = ${network}
            AND "source" IS NOT NULL
        `,
      this.prisma.paymentIntent.findMany({
        where: { consumerId, network, status: 'SUCCEEDED' },
        select: {
          id: true,
          kind: true,
          status: true,
          amount: true,
          asset: true,
          chain: true,
          destination: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      this.prisma.$queryRaw<SettledAssetSqlRow[]>`${settledAssetsSql(
        consumerId,
        network,
        null,
        null,
      )}`,
      // Never throws: without NEAR Intents' prices the USD fields are null.
      this.usd.pricer(network),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusRows) byStatus[row.status] = row._count._all;

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const succeededCount = byStatus['SUCCEEDED'] ?? 0;
    const successRate = total
      ? Math.round((succeededCount / total) * 1000) / 10
      : 0;

    // Gross settled volume per chain and asset (succeeded intents). The native
    // alias is folded onto the chain's coin by the CASE in the GROUP BY, so
    // every row already carries a distinct label. Re-folding here would mean parsing the numeric
    // back through Number and adding in float64 — exactly what
    // `formatNumericAmount` exists to avoid, since a seven-decimal Stellar
    // amount does not survive the round trip.
    //
    // Each row's USD value adds its issuers' priced amounts (one code from two issuers is two
    // tokens); `unpriced` counts the settled payments no price covers.
    const settled = settledRows.map(settledRow);
    const volume = volumeRows.map((row) => {
      const value = valueRows(
        settled.filter((s) => s.chain === row.chain && s.asset === row.asset),
        pricer,
      );
      return {
        chain: row.chain,
        asset: row.asset,
        amount: formatNumericAmount(row.amount, placesFor(row.chain)),
        count: toCount(row.count),
        amountUsd: value.priced > 0 ? formatUsd(value.usd) : null,
      };
    });
    const settledValue = valueRows(settled, pricer);

    // 30-day daily series (count + settled volume) for the sparklines. The
    // buckets are pre-seeded so a day with no activity still renders as a zero
    // rather than a gap.
    const start = Date.now() - 29 * DAY_MS;
    const series: { date: string; count: number; volume: string }[] = [];
    for (let d = 0; d < 30; d++) {
      const day = new Date(start + d * DAY_MS);
      series.push({
        date: day.toISOString().slice(0, 10),
        count: 0,
        volume: '0',
      });
    }
    const indexByDate = new Map(series.map((s, idx) => [s.date, idx]));
    for (const row of seriesRows) {
      const key = new Date(row.day).toISOString().slice(0, 10);
      const idx = indexByDate.get(key);
      if (idx === undefined) continue;
      series[idx].count = toCount(row.count);
      series[idx].volume = formatNumericAmount(row.volume);
    }

    // Webhook health.
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { consumerId },
      select: { id: true },
    });
    const endpointIds = endpoints.map((e) => e.id);
    const [deliveries, failedDeliveries] = await Promise.all([
      endpointIds.length
        ? this.prisma.webhookDelivery.count({
            where: { endpointId: { in: endpointIds } },
          })
        : Promise.resolve(0),
      endpointIds.length
        ? this.prisma.webhookDelivery.count({
            where: { endpointId: { in: endpointIds }, status: 'FAILED' },
          })
        : Promise.resolve(0),
    ]);

    const distinctPayers = toCount(payerRows[0]?.payers);

    return {
      totals: {
        all: total,
        succeeded: succeededCount,
        pending: byStatus['PENDING'] ?? 0,
        submitted: byStatus['SUBMITTED'] ?? 0,
        failed: byStatus['FAILED'] ?? 0,
        cancelled: byStatus['CANCELLED'] ?? 0,
        expired: byStatus['EXPIRED'] ?? 0,
        successRate,
      },
      volume,
      volumeUsd: formatUsd(settledValue.usd),
      unpriced: settledValue.unpriced,
      webhooks: {
        endpoints: endpoints.length,
        deliveries,
        failedDeliveries,
      },
      customers: distinctPayers,
      series,
      recent: succeededRecent.map((i) => this.recentRow(i)),
    };
  }

  private recentRow(i: {
    id: string;
    kind: string;
    status: PaymentIntentStatus;
    amount: string | null;
    asset: string;
    chain: string;
    destination: string;
    createdAt: Date;
  }) {
    return {
      id: i.id,
      kind: i.kind,
      status: i.status,
      chain: i.chain,
      amount: i.amount,
      asset: assetLabel(i.asset, i.chain),
      destination: i.destination,
      createdAt: i.createdAt,
    };
  }

  // ── Series (the dashboard chart) ────────────────────────────────────────────
  /**
   * The dashboard chart's series (`GET /v1/summary/series`), grouped by day, week, month or year
   * (30, 12, 12, 5 buckets), each bucket pre-seeded so a quiet one is a zero, with the window's
   * totals and the same figures for the window just before it, for growth:
   *
   *   - payments: each bucket's count, settled and failed counts and settled volume; the
   *     window's distinct payers. As in `summary`, `volume` adds every asset's amount, and
   *     `volumeUsd` values each asset at NEAR Intents' current price (`usd-prices.ts`), the
   *     window's `unpriced` counting the payments in an asset it lists no price for.
   *   - swaps of every kind (Stellar DEX, Solana and Monad, cross-chain, USDT0 sent through
   *     LayerZero): each bucket's count, succeeded and failed; the window's in-progress count
   *     and its split by kind.
   *   - liquidity operations: each bucket's count, succeeded and failed.
   *   - webhook deliveries: each bucket's deliveries and failed ones.
   *
   * Every figure is an aggregation in Postgres bounded by the window; no row is materialized.
   * Payments, swaps and liquidity operations are the consumer's on the network its key targets
   * (`resolveNetwork`), the scope the payments half has always had. Solana, Monad, cross-chain
   * swaps and USDT0 transfers are always written as `public`, so a sandbox key counts none of
   * them.
   * Webhook deliveries are the consumer's on every endpoint, as in `summary`: an endpoint
   * belongs to no network. Which status is succeeded, failed or in progress is the
   * `*_OUTCOMES` table of each model (`analytics.constants.ts`).
   */
  async series(consumer: GatewayConsumer, period: SeriesPeriod) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);
    const { buckets, since, previousSince } = seriesWindow(period, new Date());
    // `period` is one of SERIES_PERIODS (the DTO checks it), so it is safe as SQL text.
    const unit = Prisma.raw(`'${period}'`);
    const swapRows = (from: Date) => swapRowsSql(consumerId, network, from);

    const [
      bucketRows,
      windowRows,
      swapBucketRows,
      swapWindowRows,
      liquidityRows,
      webhookRows,
      liquidityBucketRows,
      webhookBucketRows,
      settledRows,
      pricer,
    ] = await Promise.all([
      this.prisma.$queryRaw<
        {
          bucket: Date;
          count: bigint;
          succeeded: bigint;
          failed: bigint;
          volume: string | null;
        }[]
      >`
        SELECT date_trunc(${unit}, "createdAt") AS bucket,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED') AS succeeded,
               COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'CANCELLED', 'EXPIRED')) AS failed,
               SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED') AS volume
        FROM "payment_intent"
        WHERE "consumerId" = ${consumerId}
          AND "network" = ${network}
          AND "createdAt" >= ${since}
        GROUP BY 1
      `,
      this.prisma.$queryRaw<
        {
          current: boolean;
          count: bigint;
          succeeded: bigint;
          failed: bigint;
          volume: string | null;
          payers: bigint;
        }[]
      >`
        SELECT ("createdAt" >= ${since}) AS current,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED') AS succeeded,
               COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'CANCELLED', 'EXPIRED')) AS failed,
               SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED') AS volume,
               COUNT(DISTINCT "source") FILTER (WHERE "status" = 'SUCCEEDED') AS payers
        FROM "payment_intent"
        WHERE "consumerId" = ${consumerId}
          AND "network" = ${network}
          AND "createdAt" >= ${previousSince}
        GROUP BY 1
      `,
      this.prisma.$queryRaw<
        { bucket: Date; count: bigint; succeeded: bigint; failed: bigint }[]
      >`
        SELECT date_trunc(${unit}, "createdAt") AS bucket,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE "outcome" = 'succeeded') AS succeeded,
               COUNT(*) FILTER (WHERE "outcome" = 'failed') AS failed
        FROM (${swapRows(since)}) AS swaps
        GROUP BY 1
      `,
      this.prisma.$queryRaw<
        {
          current: boolean;
          kind: SeriesSwapKind;
          count: bigint;
          succeeded: bigint;
          failed: bigint;
          in_progress: bigint;
        }[]
      >`
        SELECT ("createdAt" >= ${since}) AS current,
               "kind",
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE "outcome" = 'succeeded') AS succeeded,
               COUNT(*) FILTER (WHERE "outcome" = 'failed') AS failed,
               COUNT(*) FILTER (WHERE "outcome" = 'inProgress') AS in_progress
        FROM (${swapRows(previousSince)}) AS swaps
        GROUP BY 1, 2
      `,
      this.prisma.$queryRaw<
        { current: boolean; count: bigint; succeeded: bigint; failed: bigint }[]
      >`
        SELECT ("createdAt" >= ${since}) AS current,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE ${statusIn(LIQUIDITY_OPERATION_OUTCOMES, 'succeeded')}) AS succeeded,
               COUNT(*) FILTER (WHERE ${statusIn(LIQUIDITY_OPERATION_OUTCOMES, 'failed')}) AS failed
        FROM "liquidity_pool_operation"
        WHERE "consumerId" = ${consumerId}
          AND "network" = ${network}
          AND "createdAt" >= ${previousSince}
        GROUP BY 1
      `,
      // The deliveries `summary` counts, joined to the consumer's endpoints in Postgres rather
      // than through a list of their ids, and bounded by the window.
      this.prisma.$queryRaw<
        { current: boolean; deliveries: bigint; failed: bigint }[]
      >`
        SELECT (d."createdAt" >= ${since}) AS current,
               COUNT(*) AS deliveries,
               COUNT(*) FILTER (WHERE d."status" = 'FAILED') AS failed
        FROM "webhook_delivery" d
        JOIN "webhook_endpoint" e ON e."id" = d."endpointId"
        WHERE e."consumerId" = ${consumerId}
          AND d."createdAt" >= ${previousSince}
        GROUP BY 1
      `,
      // The same liquidity operations, per bucket of the window.
      this.prisma.$queryRaw<
        { bucket: Date; count: bigint; succeeded: bigint; failed: bigint }[]
      >`
        SELECT date_trunc(${unit}, "createdAt") AS bucket,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE ${statusIn(LIQUIDITY_OPERATION_OUTCOMES, 'succeeded')}) AS succeeded,
               COUNT(*) FILTER (WHERE ${statusIn(LIQUIDITY_OPERATION_OUTCOMES, 'failed')}) AS failed
        FROM "liquidity_pool_operation"
        WHERE "consumerId" = ${consumerId}
          AND "network" = ${network}
          AND "createdAt" >= ${since}
        GROUP BY 1
      `,
      // The same deliveries, per bucket of the window.
      this.prisma.$queryRaw<
        { bucket: Date; deliveries: bigint; failed: bigint }[]
      >`
        SELECT date_trunc(${unit}, d."createdAt") AS bucket,
               COUNT(*) AS deliveries,
               COUNT(*) FILTER (WHERE d."status" = 'FAILED') AS failed
        FROM "webhook_delivery" d
        JOIN "webhook_endpoint" e ON e."id" = d."endpointId"
        WHERE e."consumerId" = ${consumerId}
          AND d."createdAt" >= ${since}
        GROUP BY 1
      `,
      // The settled payments of both windows per bucket and asset, for their USD value.
      this.prisma.$queryRaw<SettledAssetSqlRow[]>`${settledAssetsSql(
        consumerId,
        network,
        previousSince,
        unit,
      )}`,
      // Never throws: without NEAR Intents' prices the USD fields are null.
      this.usd.pricer(network),
    ]);

    const window = (current: boolean) => {
      const row = windowRows.find((r) => r.current === current);
      return {
        count: toCount(row?.count),
        succeeded: toCount(row?.succeeded),
        failed: toCount(row?.failed),
        volume: formatNumericAmount(row?.volume ?? null),
        payers: toCount(row?.payers),
      };
    };
    const totals = window(true);
    const before = window(false);

    // The USD side: each bucket's settled assets and both windows' (a bucket of the window
    // before starts before `since`: `date_trunc` puts both on the same boundaries).
    const settledByBucket = new Map<string, SettledRow[]>();
    const settledNow: SettledRow[] = [];
    const settledBefore: SettledRow[] = [];
    for (const row of settledRows) {
      if (!row.bucket) continue;
      const item = settledRow(row);
      if (new Date(row.bucket).getTime() < since.getTime()) {
        settledBefore.push(item);
        continue;
      }
      settledNow.push(item);
      const key = bucketKey(row.bucket);
      settledByBucket.set(key, [...(settledByBucket.get(key) ?? []), item]);
    }
    const nowUsd = valueRows(settledNow, pricer);
    const beforeUsd = valueRows(settledBefore, pricer);

    // At most one row per (window, kind): summing them here adds a handful of counts, not rows.
    const swapWindow = (current: boolean) => {
      const rows = swapWindowRows.filter((r) => r.current === current);
      const sum = (pick: (r: (typeof rows)[number]) => bigint) =>
        rows.reduce((n, r) => n + toCount(pick(r)), 0);
      const byKind = Object.fromEntries(
        SERIES_SWAP_KINDS.map((kind) => [
          kind,
          toCount(rows.find((r) => r.kind === kind)?.count),
        ]),
      ) as Record<SeriesSwapKind, number>;
      return {
        count: sum((r) => r.count),
        succeeded: sum((r) => r.succeeded),
        failed: sum((r) => r.failed),
        inProgress: sum((r) => r.in_progress),
        byKind,
      };
    };
    const swapTotals = swapWindow(true);
    const swapsBefore = swapWindow(false);

    const outcomes = (
      row: { count: bigint; succeeded: bigint; failed: bigint } | undefined,
    ) => ({
      count: toCount(row?.count),
      succeeded: toCount(row?.succeeded),
      failed: toCount(row?.failed),
    });
    const deliveries = (
      row: { deliveries: bigint; failed: bigint } | undefined,
    ) => ({
      deliveries: toCount(row?.deliveries),
      failed: toCount(row?.failed),
    });

    return {
      period,
      buckets: fillBuckets(
        buckets,
        bucketRows,
        () => ({ count: 0, succeeded: 0, failed: 0, volume: '0' }),
        (row) => ({
          count: toCount(row.count),
          succeeded: toCount(row.succeeded),
          failed: toCount(row.failed),
          volume: formatNumericAmount(row.volume),
        }),
      ).map((bucket) => ({
        ...bucket,
        volumeUsd: formatUsd(
          valueRows(settledByBucket.get(bucket.start) ?? [], pricer).usd,
        ),
      })),
      totals: {
        ...totals,
        volumeUsd: formatUsd(nowUsd.usd),
        unpriced: nowUsd.unpriced,
      },
      previous: {
        count: before.count,
        succeeded: before.succeeded,
        failed: before.failed,
        volume: before.volume,
        volumeUsd: formatUsd(beforeUsd.usd),
        unpriced: beforeUsd.unpriced,
      },
      swaps: {
        buckets: fillBuckets(
          buckets,
          swapBucketRows,
          () => ({ count: 0, succeeded: 0, failed: 0 }),
          outcomes,
        ),
        totals: swapTotals,
        previous: {
          count: swapsBefore.count,
          succeeded: swapsBefore.succeeded,
          failed: swapsBefore.failed,
        },
      },
      liquidity: {
        buckets: fillBuckets(
          buckets,
          liquidityBucketRows,
          () => ({ count: 0, succeeded: 0, failed: 0 }),
          outcomes,
        ),
        totals: outcomes(liquidityRows.find((r) => r.current)),
        previous: outcomes(liquidityRows.find((r) => !r.current)),
      },
      webhooks: {
        buckets: fillBuckets(
          buckets,
          webhookBucketRows,
          () => ({ deliveries: 0, failed: 0 }),
          deliveries,
        ),
        totals: deliveries(webhookRows.find((r) => r.current)),
        previous: deliveries(webhookRows.find((r) => !r.current)),
      },
    };
  }

  // ── Balances (settled per asset) ────────────────────────────────────────────
  async balances(consumer: GatewayConsumer) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);
    // Same treatment as summary(): one grouped aggregation instead of loading
    // every intent for the consumer and reducing it in JS. `FILTER (WHERE …)`
    // gives the settled and in-flight sums in a single pass over the index.
    const rows = await this.prisma.$queryRaw<
      {
        chain: string;
        asset: string;
        settled: string | null;
        pending: string | null;
        settled_count: bigint;
      }[]
    >`
      SELECT "chain",
             ${ASSET_LABEL_SQL} AS asset,
             SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED') AS settled,
             SUM("amount"::numeric) FILTER (WHERE "status" IN ('PENDING', 'SUBMITTED')) AS pending,
             COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED') AS settled_count
      FROM "payment_intent"
      WHERE "consumerId" = ${consumerId}
        AND "network" = ${network}
      GROUP BY 1, 2
      ORDER BY SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED')
               DESC NULLS LAST
    `;

    // Postgres has already labelled, summed and ordered, so the rows map
    // straight through. Summing them again in JS would convert exact numerics
    // to float64 and lose the precision the `String` amount column was chosen
    // to keep.
    const data = rows.map((row) => ({
      chain: row.chain,
      asset: row.asset,
      amount: formatNumericAmount(row.settled, placesFor(row.chain)),
      pending: formatNumericAmount(row.pending, placesFor(row.chain)),
      count: toCount(row.settled_count),
    }));

    return { data, total: data.length };
  }

  // ── API request logs (real inbound requests, with details) ──────────────────
  async apiLogs(consumer: GatewayConsumer, query: PaginationQueryDto) {
    // RequestLog is keyed by the forwarded consumer username (not the local id).
    // `internal: false` excludes the dashboard's own management-console calls,
    // which are now recorded and flagged rather than skipped at write time.
    const where = { consumer: consumer.username, internal: false };
    const [rows, total] = await Promise.all([
      this.prisma.requestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
      }),
      this.prisma.requestLog.count({ where }),
    ]);
    const data = rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      ip: r.ip,
      userAgent: r.userAgent,
      status:
        r.statusCode < 400 ? 'ok' : r.statusCode < 500 ? 'pending' : 'fail',
      at: r.createdAt,
    }));
    return page(data, total, query);
  }

  // ── Webhook delivery logs (across all the consumer's endpoints) ──────────────
  async webhookLogs(consumer: GatewayConsumer, query: PaginationQueryDto) {
    const consumerId = await this.resolveConsumerId(consumer);
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { consumerId },
      select: { id: true, url: true },
    });
    if (!endpoints.length) return page([], 0, query);

    const urlById = new Map(endpoints.map((e) => [e.id, e.url]));
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: { in: endpoints.map((e) => e.id) } },
      orderBy: { createdAt: 'desc' },
      take: query.take,
      skip: query.skip,
      // The body never leaves PostgreSQL. WebhooksService.listDeliveries omits
      // it for this exact reason, and this route reads the same rows under the
      // same `webhooks:read` scope. Relying on the projection below to drop it
      // would mean one spread operator re-opens the leak.
      omit: { payload: true },
    });

    const total = await this.prisma.webhookDelivery.count({
      where: { endpointId: { in: endpoints.map((e) => e.id) } },
    });

    const data = deliveries.map((d) => ({
      id: d.id,
      endpointId: d.endpointId,
      url: urlById.get(d.endpointId) ?? null,
      eventType: d.eventType,
      eventId: d.eventId,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.error,
      status:
        d.status === 'SUCCEEDED'
          ? 'ok'
          : d.status === 'FAILED'
            ? 'fail'
            : 'pending',
      at: d.lastAttemptAt ?? d.createdAt,
    }));
    // The row count, never `data.length` — which always equals `take` on a full
    // page, so a caller could never tell a full page from the last one.
    return page(data, total, query);
  }
}
