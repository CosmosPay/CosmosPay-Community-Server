import { Prisma } from '@generated/prisma/client';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { AnalyticsService } from '@/analytics/analytics.service';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

const consumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'prod',
  role: 'user',
  permissions: [],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
} as GatewayConsumer;

/**
 * `summary` and `balances` used to load every payment intent for the consumer
 * and reduce the array in JS. They now aggregate in Postgres, so these tests
 * assert on the shape the SQL returns — and, critically, that no unbounded
 * `findMany` is issued: the only row fetch left is the 6-row "recent" list.
 */
describe('AnalyticsService', () => {
  /** The SQL text of the nth `$queryRaw` tagged template, whitespace-collapsed. */
  // A nested `Prisma.sql` / `Prisma.raw` fragment is spliced in as its text,
  // the way the real client composes it; anything else is a bound parameter.
  const sqlOf = (queryRaw: jest.Mock, nth: number): string => {
    const [strings, ...values] = queryRaw.mock.calls[nth] as [
      string[],
      ...unknown[],
    ];
    return strings
      .map((part, i) => {
        if (i === strings.length - 1) return part;
        const value = values[i];
        return value instanceof Prisma.Sql ? part + value.sql : `${part}?`;
      })
      .join('')
      .replace(/\s+/g, ' ');
  };

  function build(queryResults: unknown[][]) {
    const queryRaw = jest.fn();
    for (const result of queryResults) queryRaw.mockResolvedValueOnce(result);

    const findMany = jest.fn().mockResolvedValue([]);
    // Mirrors the real config: no environment header falls back to this.
    const config = { get: () => ({ network: 'testnet' }) };
    const prisma = {
      consumer: {
        upsert: jest.fn().mockResolvedValue({ id: 'c1' }),
      },
      paymentIntent: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'SUCCEEDED', _count: { _all: 7 } },
          { status: 'PENDING', _count: { _all: 3 } },
        ]),
        findMany,
      },
      webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
      webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };
    return {
      service: new AnalyticsService(
        prisma as never,
        config as never,
        new ConsumerResolverService(prisma as never),
      ),
      prisma,
      findMany,
    };
  }

  it('derives totals and success rate from the grouped status counts', async () => {
    const { service } = build([
      [], // volume
      [], // series
      [{ payers: 4n }], // distinct payers
    ]);

    const result = await service.summary(consumer);

    expect(result.totals.all).toBe(10);
    expect(result.totals.succeeded).toBe(7);
    expect(result.totals.pending).toBe(3);
    expect(result.totals.successRate).toBe(70);
    expect(result.customers).toBe(4);
  });

  it('never loads the full intent table — only the six recent rows', async () => {
    const { service, findMany } = build([[], [], [{ payers: 0n }]]);

    await service.summary(consumer);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      take: 6,
      where: { status: 'SUCCEEDED' },
    });
  });

  it('keeps exact decimal precision on a summed numeric', async () => {
    // A float sum of these would drift; the numeric sum comes back exact and
    // must survive formatting unchanged.
    const { service } = build([
      [{ asset: 'USDC', amount: '90071992547409.9100000', count: 3n }],
      [],
      [{ payers: 1n }],
    ]);

    const result = await service.summary(consumer);

    expect(result.volume).toEqual([
      { asset: 'USDC', amount: '90071992547409.91', count: 3 },
    ]);
  });

  it('folds the native alias onto each chain’s coin in SQL, not in JS', async () => {
    // The fold has to happen inside the GROUP BY. Folding it afterwards in JS
    // meant adding two exact numerics back through `Number`, which is the one
    // thing `formatNumericAmount` exists to prevent.
    const { service, prisma } = build([[], [], [{ payers: 0n }]]);

    await service.summary(consumer);

    const sql = sqlOf(prisma.$queryRaw, 0);
    expect(sql).toContain(`CASE WHEN "asset" IN ('', 'native') THEN`);
    expect(sql).toContain(`WHEN 'solana' THEN 'SOL'`);
    expect(sql).toContain(`WHEN 'monad' THEN 'MON'`);
    expect(sql).toContain(`ELSE 'XLM'`);
    // Grouped by chain too: SOL never lands in XLM's row.
    expect(sql).toContain('GROUP BY 1, 2');
  });

  it('passes an aggregated row straight through and tolerates a null sum', async () => {
    const { service } = build([
      [{ chain: 'stellar', asset: 'XLM', amount: null, count: 0n }],
      [],
      [{ payers: 0n }],
    ]);

    const result = await service.summary(consumer);

    expect(result.volume).toEqual([
      { chain: 'stellar', asset: 'XLM', amount: '0', count: 0 },
    ]);
  });

  it('seeds 30 day buckets and fills only the days that have rows', async () => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const key = day.toISOString().slice(0, 10);

    const { service } = build([
      [],
      [{ day, count: 5n, volume: '12.5000000' }],
      [{ payers: 2n }],
    ]);

    const result = await service.summary(consumer);

    expect(result.series).toHaveLength(30);
    const today = result.series.find((s) => s.date === key);
    expect(today).toEqual({ date: key, count: 5, volume: '12.5' });
    // Every other bucket stays an explicit zero rather than a gap.
    expect(result.series.filter((s) => s.count === 0)).toHaveLength(29);
  });

  it('balances separates settled from pending and tolerates a null sum', async () => {
    const { service } = build([
      [
        {
          asset: 'XLM',
          settled: '12.0000000',
          pending: '2.0000000',
          settled_count: 3n,
        },
        {
          asset: 'USDC',
          settled: '1.5000000',
          pending: null,
          settled_count: 1n,
        },
      ],
    ]);

    const result = await service.balances(consumer);

    expect(result.data).toEqual([
      { asset: 'XLM', amount: '12', pending: '2', count: 3 },
      { asset: 'USDC', amount: '1.5', pending: '0', count: 1 },
    ]);
    expect(result.total).toBe(2);
  });

  it('balances folds and orders in SQL, and never re-sums in float', async () => {
    // Two amounts whose float64 sum drifts. Postgres returns them already
    // summed; the service must not touch them again.
    const { service, prisma } = build([
      [
        {
          chain: 'stellar',
          asset: 'USDC',
          settled: '90071992547409.9100000',
          pending: '0.1000000',
          settled_count: 2n,
        },
      ],
    ]);

    const result = await service.balances(consumer);

    const sql = sqlOf(prisma.$queryRaw, 0);
    expect(sql).toContain(`ELSE 'XLM'`);
    expect(sql).toContain('GROUP BY 1, 2');
    // Ordering is the database's job too — a JS sort would have to parse the
    // amounts back to numbers to compare them.
    expect(sql).toContain('ORDER BY');
    expect(result.data[0].amount).toBe('90071992547409.91');
    expect(result.data[0].pending).toBe('0.1');
  });
});

describe('AnalyticsService.series', () => {
  afterEach(() => jest.useRealTimers());

  /** What each of the six aggregations answers, in the order the service issues them. */
  type Results = Partial<
    Record<
      | 'buckets'
      | 'windows'
      | 'swapBuckets'
      | 'swapWindows'
      | 'liquidity'
      | 'webhooks',
      unknown[]
    >
  >;
  const ORDER = [
    'buckets',
    'windows',
    'swapBuckets',
    'swapWindows',
    'liquidity',
    'webhooks',
  ] as const;

  function build(results: Results = {}) {
    const queryRaw = jest.fn();
    for (const key of ORDER) queryRaw.mockResolvedValueOnce(results[key] ?? []);
    const config = { get: () => ({ network: 'testnet' }) };
    // Every model the series counts, so a row fetch on any of them is caught.
    const rowFetch = () => ({ findMany: jest.fn(), count: jest.fn() });
    const prisma = {
      consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
      paymentIntent: rowFetch(),
      swap: rowFetch(),
      chainSwap: rowFetch(),
      crossChainSwap: rowFetch(),
      liquidityPoolOperation: rowFetch(),
      webhookEndpoint: rowFetch(),
      webhookDelivery: rowFetch(),
      $queryRaw: queryRaw,
    };
    const service = new AnalyticsService(
      prisma as never,
      config as never,
      new ConsumerResolverService(prisma as never),
    );
    return { service, queryRaw, prisma };
  }

  /**
   * The nth aggregation as Postgres receives it: the SQL text, whitespace-collapsed, with every
   * nested `Prisma.sql` / `Prisma.raw` fragment composed in and a `$n` per bound value; and the
   * bound values, in order.
   */
  const queryOf = (queryRaw: jest.Mock, nth: number) => {
    const [strings, ...values] = queryRaw.mock.calls[nth] as [
      string[],
      ...unknown[],
    ];
    const query = new Prisma.Sql(strings, values);
    return { sql: query.text.replace(/\s+/g, ' '), values: query.values };
  };

  // A Thursday afternoon: the month window is 2025-11-01 to now, the one before from 2024-11-01.
  const NOW = new Date('2026-10-22T15:30:00Z');
  const SINCE = new Date('2025-11-01T00:00:00Z');
  const PREVIOUS_SINCE = new Date('2024-11-01T00:00:00Z');

  it('groups by the asked period in Postgres and seeds every bucket', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw, prisma } = build({
      buckets: [
        {
          bucket: new Date('2026-10-01T00:00:00Z'),
          count: 5n,
          succeeded: 4n,
          failed: 1n,
          volume: '120.5000000',
        },
      ],
      windows: [
        {
          current: true,
          count: 5n,
          succeeded: 4n,
          failed: 1n,
          volume: '120.5',
          payers: 3n,
        },
        {
          current: false,
          count: 2n,
          succeeded: 2n,
          failed: 0n,
          volume: '80',
          payers: 2n,
        },
      ],
    });

    const result = await service.series(consumer, 'month');

    expect(result.period).toBe('month');
    expect(result.buckets).toHaveLength(12);
    expect(result.buckets[0]).toEqual({
      start: '2025-11-01',
      count: 0,
      succeeded: 0,
      failed: 0,
      volume: '0',
    });
    expect(result.buckets[11]).toEqual({
      start: '2026-10-01',
      count: 5,
      succeeded: 4,
      failed: 1,
      volume: '120.5',
    });
    expect(result.totals).toEqual({
      count: 5,
      succeeded: 4,
      failed: 1,
      volume: '120.5',
      payers: 3,
    });
    expect(result.previous).toEqual({
      count: 2,
      succeeded: 2,
      failed: 0,
      volume: '80',
    });
    // Six aggregations (payments twice, swaps twice, liquidity, webhooks), no row fetched.
    expect(queryRaw).toHaveBeenCalledTimes(6);
    for (const model of [
      prisma.paymentIntent,
      prisma.swap,
      prisma.chainSwap,
      prisma.crossChainSwap,
      prisma.liquidityPoolOperation,
      prisma.webhookEndpoint,
      prisma.webhookDelivery,
    ]) {
      expect(model.findMany).not.toHaveBeenCalled();
      expect(model.count).not.toHaveBeenCalled();
    }
    const { sql } = queryOf(queryRaw, 0);
    expect(sql).toContain(`date_trunc('month', "createdAt")`);
    expect(sql).toContain('GROUP BY 1');
  });

  it('counts every kind of swap on the same buckets as the payments', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service } = build({
      swapBuckets: [
        {
          bucket: new Date('2026-10-01T00:00:00Z'),
          count: 4n,
          succeeded: 2n,
          failed: 1n,
        },
      ],
      swapWindows: [
        {
          current: true,
          kind: 'dex',
          count: 3n,
          succeeded: 2n,
          failed: 0n,
          in_progress: 1n,
        },
        {
          current: true,
          kind: 'chain',
          count: 1n,
          succeeded: 0n,
          failed: 1n,
          in_progress: 0n,
        },
        // No cross-chain swap in the window: no row, and a zero in byKind.
        {
          current: false,
          kind: 'crossChain',
          count: 2n,
          succeeded: 1n,
          failed: 1n,
          in_progress: 0n,
        },
      ],
    });

    const result = await service.series(consumer, 'month');

    expect(result.swaps.buckets.map((b) => b.start)).toEqual(
      result.buckets.map((b) => b.start),
    );
    expect(result.swaps.buckets[0]).toEqual({
      start: '2025-11-01',
      count: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(result.swaps.buckets[11]).toEqual({
      start: '2026-10-01',
      count: 4,
      succeeded: 2,
      failed: 1,
    });
    expect(result.swaps.totals).toEqual({
      count: 4,
      succeeded: 2,
      failed: 1,
      inProgress: 1,
      byKind: { dex: 3, chain: 1, crossChain: 0 },
    });
    expect(result.swaps.previous).toEqual({
      count: 2,
      succeeded: 1,
      failed: 1,
    });
  });

  it('reads the three swap tables in one union, each scoped to the consumer and the key’s network', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build();

    await service.series(consumer, 'month');

    const buckets = queryOf(queryRaw, 2);
    expect(buckets.sql).toContain(`date_trunc('month', "createdAt")`);
    expect(buckets.sql).toContain(`FROM "swap"`);
    expect(buckets.sql).toContain(`FROM "chain_swap"`);
    expect(buckets.sql).toContain(`FROM "cross_chain_swap"`);
    expect(buckets.sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(buckets.sql.match(/"network" = \$\d+/g)).toHaveLength(3);
    // Every branch binds the consumer, the prod key's network and the window's start.
    expect(buckets.values).toEqual([
      ...['c1', 'public', SINCE],
      ...['c1', 'public', SINCE],
      ...['c1', 'public', SINCE],
    ]);
    // Each table's statuses are read through its own outcome table.
    expect(buckets.sql).toContain(
      `SELECT 'crossChain' AS "kind", "createdAt", CASE WHEN "status" IN ('SUCCEEDED') THEN 'succeeded' ` +
        `WHEN "status" IN ('REFUNDED', 'FAILED', 'EXPIRED') THEN 'failed' `,
    );
    expect(buckets.sql).toContain(
      `SELECT 'dex' AS "kind", "createdAt", CASE WHEN "status" IN ('SUCCEEDED') THEN 'succeeded' ` +
        `WHEN "status" IN ('FAILED', 'EXPIRED') THEN 'failed' ` +
        `WHEN "status" IN ('PENDING', 'SUBMITTED') THEN 'inProgress' END`,
    );

    // The window totals read both windows, split by kind.
    const windows = queryOf(queryRaw, 3);
    expect(windows.sql).toContain(
      `COUNT(*) FILTER (WHERE "outcome" = 'inProgress')`,
    );
    expect(windows.sql).toContain('GROUP BY 1, 2');
    expect(windows.values).toEqual([
      SINCE,
      ...['c1', 'public', PREVIOUS_SINCE],
      ...['c1', 'public', PREVIOUS_SINCE],
      ...['c1', 'public', PREVIOUS_SINCE],
    ]);
  });

  it('scopes a sandbox key to testnet, where no Solana, Monad or cross-chain swap is written', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const sandbox = { ...consumer, environment: 'dev' } as GatewayConsumer;
    const { service, queryRaw } = build();

    await service.series(sandbox, 'month');

    for (const nth of [0, 1, 2, 3, 4]) {
      const { values } = queryOf(queryRaw, nth);
      expect(values).toContain('testnet');
      expect(values).not.toContain('public');
    }
  });

  it('counts liquidity operations and webhook deliveries in the window and the one before', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build({
      liquidity: [
        { current: true, count: 3n, succeeded: 1n, failed: 2n },
        { current: false, count: 1n, succeeded: 1n, failed: 0n },
      ],
      webhooks: [{ current: true, deliveries: 10n, failed: 2n }],
    });

    const result = await service.series(consumer, 'month');

    expect(result.liquidity).toEqual({
      totals: { count: 3, succeeded: 1, failed: 2 },
      previous: { count: 1, succeeded: 1, failed: 0 },
    });
    expect(result.webhooks).toEqual({
      totals: { deliveries: 10, failed: 2 },
      previous: { deliveries: 0, failed: 0 },
    });

    const liquidity = queryOf(queryRaw, 4);
    expect(liquidity.sql).toContain(`FROM "liquidity_pool_operation"`);
    expect(liquidity.sql).toContain(
      `COUNT(*) FILTER (WHERE "status" IN ('SUCCEEDED')) AS succeeded`,
    );
    expect(liquidity.sql).toContain(
      `COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'EXPIRED')) AS failed`,
    );
    expect(liquidity.values).toEqual([SINCE, 'c1', 'public', PREVIOUS_SINCE]);

    // Deliveries are the consumer's on every endpoint: an endpoint has no network.
    const webhooks = queryOf(queryRaw, 5);
    expect(webhooks.sql).toContain(
      `JOIN "webhook_endpoint" e ON e."id" = d."endpointId"`,
    );
    expect(webhooks.sql).toContain(
      `COUNT(*) FILTER (WHERE d."status" = 'FAILED')`,
    );
    expect(webhooks.sql).not.toContain('"network"');
    expect(webhooks.values).toEqual([SINCE, 'c1', PREVIOUS_SINCE]);
  });

  it('answers zeros for a window with no activity', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service } = build();

    const result = await service.series(consumer, 'year');

    expect(result.buckets.map((b) => b.start)).toEqual([
      '2022-01-01',
      '2023-01-01',
      '2024-01-01',
      '2025-01-01',
      '2026-01-01',
    ]);
    expect(result.totals).toEqual({
      count: 0,
      succeeded: 0,
      failed: 0,
      volume: '0',
      payers: 0,
    });
    expect(result.previous.volume).toBe('0');
    expect(result.swaps).toEqual({
      buckets: result.buckets.map((b) => ({
        start: b.start,
        count: 0,
        succeeded: 0,
        failed: 0,
      })),
      totals: {
        count: 0,
        succeeded: 0,
        failed: 0,
        inProgress: 0,
        byKind: { dex: 0, chain: 0, crossChain: 0 },
      },
      previous: { count: 0, succeeded: 0, failed: 0 },
    });
    expect(result.liquidity).toEqual({
      totals: { count: 0, succeeded: 0, failed: 0 },
      previous: { count: 0, succeeded: 0, failed: 0 },
    });
    expect(result.webhooks).toEqual({
      totals: { deliveries: 0, failed: 0 },
      previous: { deliveries: 0, failed: 0 },
    });
  });
});
