import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { formatNumericAmount, toCount } from '../common/money';
import { ConsumerResolverService } from '../common/services/consumer-resolver.service';
import { PaginationQueryDto } from '../common/dto/pagination.query.dto';
import { page } from '../common/pagination';
import { resolveNetwork } from '../common/stellar-network';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentIntentStatus } from '../../generated/prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

function assetLabel(asset: string): string {
  return !asset || asset === 'native' ? 'XLM' : asset;
}

/**
 * Read-only aggregates derived from the consumer's existing payment intents and
 * webhook deliveries — no separate analytics store. Powers the dashboard's
 * Overview, Balances, Customers and Logs views.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly consumers: ConsumerResolverService,
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

    const [statusRows, volumeRows, seriesRows, payerRows, succeededRecent] =
      await Promise.all([
        this.prisma.paymentIntent.groupBy({
          by: ['status'],
          where: { consumerId, network },
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<
          { asset: string; amount: string | null; count: bigint }[]
        >`
          SELECT CASE WHEN "asset" IN ('', 'native') THEN 'XLM' ELSE "asset" END
                   AS asset,
                 SUM("amount"::numeric) AS amount,
                 COUNT(*)               AS count
          FROM "payment_intent"
          WHERE "consumerId" = ${consumerId}
            AND "network" = ${network}
            AND "status" = 'SUCCEEDED'
          GROUP BY 1
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
            destination: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 6,
        }),
      ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusRows) byStatus[row.status] = row._count._all;

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const succeededCount = byStatus['SUCCEEDED'] ?? 0;
    const successRate = total
      ? Math.round((succeededCount / total) * 1000) / 10
      : 0;

    // Gross settled volume per asset (succeeded intents). The native alias is
    // folded onto 'XLM' by the CASE in the GROUP BY, so every row already
    // carries a distinct label. Re-folding here would mean parsing the numeric
    // back through Number and adding in float64 — exactly what
    // `formatNumericAmount` exists to avoid, since a seven-decimal Stellar
    // amount does not survive the round trip.
    const volume = volumeRows.map((row) => ({
      asset: row.asset,
      amount: formatNumericAmount(row.amount),
      count: toCount(row.count),
    }));

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
    destination: string;
    createdAt: Date;
  }) {
    return {
      id: i.id,
      kind: i.kind,
      status: i.status,
      amount: i.amount,
      asset: assetLabel(i.asset),
      destination: i.destination,
      createdAt: i.createdAt,
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
        asset: string;
        settled: string | null;
        pending: string | null;
        settled_count: bigint;
      }[]
    >`
      SELECT CASE WHEN "asset" IN ('', 'native') THEN 'XLM' ELSE "asset" END
               AS asset,
             SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED') AS settled,
             SUM("amount"::numeric) FILTER (WHERE "status" IN ('PENDING', 'SUBMITTED')) AS pending,
             COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED') AS settled_count
      FROM "payment_intent"
      WHERE "consumerId" = ${consumerId}
        AND "network" = ${network}
      GROUP BY 1
      ORDER BY SUM("amount"::numeric) FILTER (WHERE "status" = 'SUCCEEDED')
               DESC NULLS LAST
    `;

    // Postgres has already labelled, summed and ordered, so the rows map
    // straight through. Summing them again in JS would convert exact numerics
    // to float64 and lose the precision the `String` amount column was chosen
    // to keep.
    const data = rows.map((row) => ({
      asset: row.asset,
      amount: formatNumericAmount(row.settled),
      pending: formatNumericAmount(row.pending),
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
