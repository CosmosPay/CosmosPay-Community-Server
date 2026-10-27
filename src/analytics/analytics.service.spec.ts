import { Prisma } from '@generated/prisma/client';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { AnalyticsService } from '@/analytics/analytics.service';
import { usdPricer } from '@/analytics/usd-prices';
import type { UsdPricesService } from '@/analytics/usd-prices.service';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';
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

const STELLAR_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
/** NEAR Intents' token list as the price service reads it: XLM at 0.25, USDC at 1. */
const TOKENS: NearIntentsToken[] = [
  {
    assetId: 'nep245:xlm',
    blockchain: 'stellar',
    symbol: 'XLM',
    decimals: 7,
    price: 0.25,
  },
  {
    assetId: 'nep245:usdc',
    blockchain: 'stellar',
    symbol: 'USDC',
    decimals: 7,
    contractAddress: STELLAR_USDC_ISSUER,
    price: 1,
  },
];
/** The price service, answering a pricer over `tokens`, or null (NEAR Intents unreachable). */
const prices = (tokens: NearIntentsToken[] | null) =>
  ({
    pricer: jest.fn((network: string) =>
      Promise.resolve(tokens ? usdPricer(tokens, network) : null),
    ),
  }) as unknown as UsdPricesService;

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

  function build(
    queryResults: unknown[][],
    tokens: NearIntentsToken[] | null = null,
    cacheTtlMs = 0,
  ) {
    // An aggregation a test does not set answers no rows.
    const queryRaw = jest.fn().mockResolvedValue([]);
    for (const result of queryResults) queryRaw.mockResolvedValueOnce(result);

    const findMany = jest.fn().mockResolvedValue([]);
    // Mirrors the real config: no environment header falls back to this. The analytics cache
    // is off unless a test turns it on.
    const config = { get: () => ({ network: 'testnet', cacheTtlMs }) };
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
      webhookEndpoint: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };
    return {
      service: new AnalyticsService(
        prisma as never,
        config as never,
        new ConsumerResolverService(prisma as never),
        prices(tokens),
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
      { asset: 'USDC', amount: '90071992547409.91', count: 3, amountUsd: null },
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
      {
        chain: 'stellar',
        asset: 'XLM',
        amount: '0',
        count: 0,
        amountUsd: null,
      },
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

  it('values the settled volume in USD per asset and in total, issuer by issuer', async () => {
    const { service, prisma } = build(
      [
        [
          { chain: 'stellar', asset: 'XLM', amount: '100.0000000', count: 3n },
          { chain: 'stellar', asset: 'USDC', amount: '75', count: 3n },
        ],
        [],
        [{ payers: 2n }],
        // per issuer: one USDC is Circle's, the other an issuer NEAR Intents does not list
        [
          {
            bucket: null,
            chain: 'stellar',
            asset: 'XLM',
            issuer: null,
            amount: '100.0000000',
            count: 3n,
          },
          {
            bucket: null,
            chain: 'stellar',
            asset: 'USDC',
            issuer: STELLAR_USDC_ISSUER,
            amount: '50',
            count: 2n,
          },
          {
            bucket: null,
            chain: 'stellar',
            asset: 'USDC',
            issuer: 'GUNLISTED',
            amount: '25',
            count: 1n,
          },
        ],
      ],
      TOKENS,
    );

    const result = await service.summary(consumer);

    expect(result.volume).toEqual([
      {
        chain: 'stellar',
        asset: 'XLM',
        amount: '100',
        count: 3,
        amountUsd: '25.00',
      },
      // Only Circle's 50 is priced; the row keeps its exact 75.
      {
        chain: 'stellar',
        asset: 'USDC',
        amount: '75',
        count: 3,
        amountUsd: '50.00',
      },
    ]);
    expect(result.volumeUsd).toBe('75.00');
    expect(result.unpriced).toBe(1);
    // Priced from the issuer, which the volume rows do not group by.
    const sql = sqlOf(prisma.$queryRaw, 3);
    expect(sql).toContain('"assetIssuer" AS issuer');
    expect(sql).toContain(`AND "status" = 'SUCCEEDED'`);
    expect(sql).toContain('GROUP BY 1, 2, 3, 4');
  });

  it('answers without USD values when NEAR Intents’ prices cannot be read', async () => {
    const { service } = build([
      [{ chain: 'stellar', asset: 'XLM', amount: '10', count: 2n }],
      [],
      [{ payers: 1n }],
      [
        {
          bucket: null,
          chain: 'stellar',
          asset: 'XLM',
          issuer: null,
          amount: '10',
          count: 2n,
        },
      ],
    ]);

    const result = await service.summary(consumer);

    expect(result.volume[0].amountUsd).toBeNull();
    expect(result.volumeUsd).toBeNull();
    expect(result.unpriced).toBe(2);
    // Everything else as before.
    expect(result.volume[0].amount).toBe('10');
    expect(result.totals.all).toBe(10);
  });

  it('counts webhook health through the endpoint relation, with the other queries', async () => {
    const { service, prisma } = build([[], [], [{ payers: 0n }]]);
    prisma.webhookEndpoint.count.mockResolvedValue(2);
    prisma.webhookDelivery.count
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(1);

    const result = await service.summary(consumer);

    expect(result.webhooks).toEqual({
      endpoints: 2,
      deliveries: 9,
      failedDeliveries: 1,
    });
    // No list of endpoint ids read first: one round trip with the rest.
    expect(prisma.webhookEndpoint.findMany).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.count.mock.calls).toEqual([
      [{ where: { endpoint: { consumerId: 'c1' } } }],
      [{ where: { endpoint: { consumerId: 'c1' }, status: 'FAILED' } }],
    ]);
  });

  it('reuses an answer per consumer and network while it is fresh, and shares one in flight', async () => {
    const { service, prisma } = build([[], [], [{ payers: 0n }]], null, 10_000);

    const [a, b] = await Promise.all([
      service.summary(consumer),
      service.summary(consumer),
    ]);
    const c = await service.summary(consumer);

    expect(b).toBe(a);
    expect(c).toBe(a);
    // Computed once: one grouped count, one upsert to learn the consumer's id.
    expect(prisma.paymentIntent.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.consumer.upsert).toHaveBeenCalledTimes(1);
  });

  it('never serves one consumer, or one network, the answer of another', async () => {
    const { service, prisma } = build([], null, 10_000);
    prisma.consumer.upsert.mockImplementation(
      ({ where }: { where: { apisixUsername: string } }) =>
        Promise.resolve({ id: `local_${where.apisixUsername}` }),
    );

    await service.summary(consumer);
    await service.summary({ ...consumer, username: 'cosmos_u2' });
    await service.summary({ ...consumer, environment: 'dev' });

    // Three keys, three computations: u1 on public, u2 on public, u1 on testnet.
    expect(prisma.paymentIntent.groupBy).toHaveBeenCalledTimes(3);
    expect(
      prisma.paymentIntent.groupBy.mock.calls.map(
        ([arg]: [{ where: { consumerId: string; network: string } }]) =>
          arg.where,
      ),
    ).toEqual([
      { consumerId: 'local_cosmos_u1', network: 'public' },
      { consumerId: 'local_cosmos_u2', network: 'public' },
      { consumerId: 'local_cosmos_u1', network: 'testnet' },
    ]);
  });

  it('computes again once the answer is older than the ttl', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T12:00:00Z') });
    try {
      const { service, prisma } = build([], null, 10_000);
      await service.balances(consumer);
      jest.setSystemTime(new Date('2026-10-26T12:00:09.999Z'));
      await service.balances(consumer);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2026-10-26T12:00:10Z'));
      await service.balances(consumer);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
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

  /** What each of the twelve aggregations answers, in the order the service issues them. */
  type Results = Partial<
    Record<
      | 'buckets'
      | 'windows'
      | 'swapBuckets'
      | 'swapWindows'
      | 'liquidity'
      | 'webhooks'
      | 'liquidityBuckets'
      | 'webhookBuckets'
      | 'settled'
      | 'swapSettled'
      | 'zkBuckets'
      | 'zkWindows',
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
    'liquidityBuckets',
    'webhookBuckets',
    'settled',
    'swapSettled',
    'zkBuckets',
    'zkWindows',
  ] as const;

  function build(
    results: Results = {},
    tokens: NearIntentsToken[] | null = null,
  ) {
    const queryRaw = jest.fn();
    for (const key of ORDER) queryRaw.mockResolvedValueOnce(results[key] ?? []);
    const config = { get: () => ({ network: 'testnet', cacheTtlMs: 0 }) };
    // Every model the series counts, so a row fetch on any of them is caught.
    const rowFetch = () => ({ findMany: jest.fn(), count: jest.fn() });
    const prisma = {
      consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
      paymentIntent: rowFetch(),
      swap: rowFetch(),
      chainSwap: rowFetch(),
      crossChainSwap: rowFetch(),
      usdt0Transfer: rowFetch(),
      liquidityPoolOperation: rowFetch(),
      webhookEndpoint: rowFetch(),
      webhookDelivery: rowFetch(),
      zkPayment: rowFetch(),
      $queryRaw: queryRaw,
    };
    const service = new AnalyticsService(
      prisma as never,
      config as never,
      new ConsumerResolverService(prisma as never),
      prices(tokens),
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
    // Nothing settled in the mocked USD rows: zero dollars, whatever the volume says.
    expect(result.buckets[0]).toEqual({
      start: '2025-11-01',
      count: 0,
      succeeded: 0,
      failed: 0,
      volume: '0',
      volumeUsd: '0.00',
    });
    expect(result.buckets[11]).toEqual({
      start: '2026-10-01',
      count: 5,
      succeeded: 4,
      failed: 1,
      volume: '120.5',
      volumeUsd: '0.00',
    });
    expect(result.totals).toEqual({
      count: 5,
      succeeded: 4,
      failed: 1,
      volume: '120.5',
      payers: 3,
      volumeUsd: '0.00',
      unpriced: 0,
    });
    expect(result.previous).toEqual({
      count: 2,
      succeeded: 2,
      failed: 0,
      volume: '80',
      volumeUsd: '0.00',
      unpriced: 0,
    });
    // Eleven aggregations (payments, swaps, liquidity, webhooks and private payments, each per
    // bucket and per window, and the settled payments per asset for their USD value), no row
    // fetched.
    expect(queryRaw).toHaveBeenCalledTimes(12);
    for (const model of [
      prisma.paymentIntent,
      prisma.swap,
      prisma.chainSwap,
      prisma.crossChainSwap,
      prisma.usdt0Transfer,
      prisma.liquidityPoolOperation,
      prisma.webhookEndpoint,
      prisma.webhookDelivery,
      prisma.zkPayment,
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
        {
          current: true,
          kind: 'usdt0',
          count: 2n,
          succeeded: 1n,
          failed: 0n,
          in_progress: 1n,
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
    // No completed swap valued in this test: zero dollars per bucket.
    expect(result.swaps.buckets[0]).toEqual({
      start: '2025-11-01',
      count: 0,
      succeeded: 0,
      failed: 0,
      volumeUsd: '0.00',
    });
    expect(result.swaps.buckets[11]).toEqual({
      start: '2026-10-01',
      count: 4,
      succeeded: 2,
      failed: 1,
      volumeUsd: '0.00',
    });
    expect(result.swaps.totals).toEqual({
      count: 6,
      succeeded: 3,
      failed: 1,
      inProgress: 2,
      byKind: { dex: 3, chain: 1, crossChain: 0, usdt0: 2 },
      volumeUsd: '0.00',
      unpriced: 0,
    });
    // The kinds add up to the window's count, and so do the outcomes.
    const { byKind, count, succeeded, failed, inProgress } =
      result.swaps.totals;
    expect(Object.values(byKind).reduce((a, b) => a + b, 0)).toBe(count);
    expect(succeeded + failed + inProgress).toBe(count);
    expect(result.swaps.previous).toEqual({
      count: 2,
      succeeded: 1,
      failed: 1,
      volumeUsd: '0.00',
    });
  });

  it('reads the four swap tables in one union, each scoped to the consumer and the key’s network', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build();

    await service.series(consumer, 'month');

    const buckets = queryOf(queryRaw, 2);
    expect(buckets.sql).toContain(`date_trunc('month', "createdAt")`);
    expect(buckets.sql).toContain(`FROM "swap"`);
    expect(buckets.sql).toContain(`FROM "chain_swap"`);
    expect(buckets.sql).toContain(`FROM "cross_chain_swap"`);
    expect(buckets.sql).toContain(`FROM "usdt0_transfer"`);
    expect(buckets.sql.match(/UNION ALL/g)).toHaveLength(3);
    expect(buckets.sql.match(/"network" = \$\d+/g)).toHaveLength(4);
    // Every branch binds the consumer, the prod key's network and the window's start.
    expect(buckets.values).toEqual([
      ...['c1', 'public', SINCE],
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
    expect(buckets.sql).toContain(
      `SELECT 'usdt0' AS "kind", "createdAt", CASE WHEN "status" IN ('DELIVERED') THEN 'succeeded' ` +
        `WHEN "status" IN ('FAILED', 'EXPIRED') THEN 'failed' ` +
        `WHEN "status" IN ('PENDING', 'SUBMITTED') THEN 'inProgress' END AS "outcome", ` +
        `'stellar' AS "chain", 'USDT' AS "asset", NULL::text AS "issuer", "amount" AS "amount" FROM "usdt0_transfer"`,
    );
    // Each kind names the side it sold, as the USD pricer reads an asset.
    expect(buckets.sql).toContain(
      `'stellar' AS "chain", "sendAsset" AS "asset", "sendAssetIssuer" AS "issuer", "sendAmount" AS "amount" FROM "swap"`,
    );
    expect(buckets.sql).toContain(
      `"originChain" AS "chain", "originAsset" AS "asset", NULL::text AS "issuer", "amountIn" AS "amount" FROM "cross_chain_swap"`,
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
      ...['c1', 'public', PREVIOUS_SINCE],
    ]);
  });

  it('scopes a sandbox key to testnet, where no Solana, Monad, cross-chain swap or USDT0 transfer is written', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const sandbox = { ...consumer, environment: 'dev' } as GatewayConsumer;
    const { service, queryRaw } = build();

    await service.series(sandbox, 'month');

    for (const nth of [0, 1, 2, 3, 4, 6, 9, 10]) {
      const { values } = queryOf(queryRaw, nth);
      expect(values).toContain('testnet');
      expect(values).not.toContain('public');
    }
    // The USDT0 branch, like every other, asks for the sandbox's network, where no transfer is
    // ever written (they are all `public`): a sandbox key counts none.
    const swaps = queryOf(queryRaw, 2);
    const usdt0Branch = swaps.sql.slice(swaps.sql.indexOf(`'usdt0' AS "kind"`));
    const placeholder = /"network" = \$(\d+)/.exec(usdt0Branch)![1];
    expect(swaps.values[Number(placeholder) - 1]).toBe('testnet');
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

    expect(result.liquidity).toMatchObject({
      totals: { count: 3, succeeded: 1, failed: 2 },
      previous: { count: 1, succeeded: 1, failed: 0 },
    });
    expect(result.webhooks).toMatchObject({
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

  it('counts liquidity operations and webhook deliveries per bucket, a quiet bucket being a zero', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build({
      liquidityBuckets: [
        {
          bucket: new Date('2026-09-01T00:00:00Z'),
          count: 3n,
          succeeded: 1n,
          failed: 2n,
        },
      ],
      webhookBuckets: [
        {
          bucket: new Date('2026-10-01T00:00:00Z'),
          deliveries: 10n,
          failed: 2n,
        },
      ],
    });

    const result = await service.series(consumer, 'month');

    const starts = result.buckets.map((b) => b.start);
    expect(result.liquidity.buckets.map((b) => b.start)).toEqual(starts);
    expect(result.webhooks.buckets.map((b) => b.start)).toEqual(starts);
    expect(result.liquidity.buckets[0]).toEqual({
      start: '2025-11-01',
      count: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(result.liquidity.buckets[10]).toEqual({
      start: '2026-09-01',
      count: 3,
      succeeded: 1,
      failed: 2,
    });
    expect(result.webhooks.buckets[10]).toEqual({
      start: '2026-09-01',
      deliveries: 0,
      failed: 0,
    });
    expect(result.webhooks.buckets[11]).toEqual({
      start: '2026-10-01',
      deliveries: 10,
      failed: 2,
    });

    // Liquidity per bucket: the window only, scoped as the window totals are.
    const liquidity = queryOf(queryRaw, 6);
    expect(liquidity.sql).toContain(`date_trunc('month', "createdAt")`);
    expect(liquidity.sql).toContain(`FROM "liquidity_pool_operation"`);
    expect(liquidity.sql).toContain(
      `COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'EXPIRED')) AS failed`,
    );
    expect(liquidity.values).toEqual(['c1', 'public', SINCE]);

    // Deliveries per bucket: the same join as the totals, with no network.
    const webhooks = queryOf(queryRaw, 7);
    expect(webhooks.sql).toContain(`date_trunc('month', d."createdAt")`);
    expect(webhooks.sql).toContain(
      `JOIN "webhook_endpoint" e ON e."id" = d."endpointId"`,
    );
    expect(webhooks.sql).not.toContain('"network"');
    expect(webhooks.values).toEqual(['c1', SINCE]);
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
      volumeUsd: '0.00',
      unpriced: 0,
    });
    expect(result.previous.volume).toBe('0');
    expect(result.previous.volumeUsd).toBe('0.00');
    expect(result.buckets.every((b) => b.volumeUsd === '0.00')).toBe(true);
    expect(result.swaps).toEqual({
      buckets: result.buckets.map((b) => ({
        start: b.start,
        count: 0,
        succeeded: 0,
        failed: 0,
        volumeUsd: '0.00',
      })),
      totals: {
        count: 0,
        succeeded: 0,
        failed: 0,
        inProgress: 0,
        byKind: { dex: 0, chain: 0, crossChain: 0, usdt0: 0 },
        volumeUsd: '0.00',
        unpriced: 0,
      },
      previous: { count: 0, succeeded: 0, failed: 0, volumeUsd: '0.00' },
    });
    expect(result.liquidity).toEqual({
      buckets: result.buckets.map((b) => ({
        start: b.start,
        count: 0,
        succeeded: 0,
        failed: 0,
      })),
      totals: { count: 0, succeeded: 0, failed: 0 },
      previous: { count: 0, succeeded: 0, failed: 0 },
    });
    expect(result.webhooks).toEqual({
      buckets: result.buckets.map((b) => ({
        start: b.start,
        deliveries: 0,
        failed: 0,
      })),
      totals: { deliveries: 0, failed: 0 },
      previous: { deliveries: 0, failed: 0 },
    });
    const quietZk = {
      count: 0,
      succeeded: 0,
      expired: 0,
      volume: '0',
      volumeUsd: '0.00',
      fees: '0',
      feesUsd: '0.00',
    };
    expect(result.zkPayments).toEqual({
      buckets: result.buckets.map((b) => ({
        start: b.start,
        count: 0,
        succeeded: 0,
        expired: 0,
        volume: '0',
        volumeUsd: '0.00',
      })),
      totals: quietZk,
      previous: quietZk,
    });
  });

  it('counts private payments per bucket and window, valued at XLM’s price', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build(
      {
        zkBuckets: [
          {
            bucket: new Date('2026-10-01T00:00:00Z'),
            count: 5n,
            succeeded: 3n,
            expired: 1n,
            volume: '120.0000000',
          },
        ],
        zkWindows: [
          {
            current: true,
            count: 5n,
            succeeded: 3n,
            expired: 1n,
            volume: '120',
            fees: '0.012',
          },
          {
            current: false,
            count: 2n,
            succeeded: 0n,
            expired: 2n,
            volume: null,
            fees: null,
          },
        ],
      },
      TOKENS,
    );

    const result = await service.series(consumer, 'month');

    // The private payments use the payments' buckets; XLM at 0.25.
    expect(result.zkPayments.buckets).toHaveLength(12);
    expect(result.zkPayments.buckets[11]).toEqual({
      start: '2026-10-01',
      count: 5,
      succeeded: 3,
      expired: 1,
      volume: '120',
      volumeUsd: '30.00',
    });
    expect(result.zkPayments.buckets[0]).toEqual({
      start: '2025-11-01',
      count: 0,
      succeeded: 0,
      expired: 0,
      volume: '0',
      volumeUsd: '0.00',
    });
    expect(result.zkPayments.totals).toEqual({
      count: 5,
      succeeded: 3,
      expired: 1,
      volume: '120',
      volumeUsd: '30.00',
      fees: '0.012',
      feesUsd: '0.00',
    });
    expect(result.zkPayments.previous).toEqual({
      count: 2,
      succeeded: 0,
      expired: 2,
      volume: '0',
      volumeUsd: '0.00',
      fees: '0',
      feesUsd: '0.00',
    });

    // Per bucket of the window, and both windows from the one before, on the key's network.
    const buckets = queryOf(queryRaw, 10);
    expect(buckets.sql).toContain('FROM "zk_payment"');
    expect(buckets.sql).toContain(`date_trunc('month', "createdAt") AS bucket`);
    expect(buckets.values.slice(-3)).toEqual(['c1', 'public', SINCE]);
    const windows = queryOf(queryRaw, 11);
    expect(windows.sql).toContain('SUM("feeAmount"::numeric)');
    expect(windows.values.slice(-3)).toEqual(['c1', 'public', PREVIOUS_SINCE]);
    // Expired is derived as every read of them derives it: a pending payment past its deadline.
    for (const query of [buckets, windows]) {
      expect(query.sql).toContain(
        `"status" = 'EXPIRED' OR ("status" = 'PENDING' AND "expiresAt" <= $`,
      );
      expect(query.values).toContainEqual(NOW);
    }
  });

  it('answers the private payments without USD values when NEAR Intents’ prices cannot be read', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service } = build({
      zkBuckets: [
        {
          bucket: new Date('2026-10-01T00:00:00Z'),
          count: 1n,
          succeeded: 1n,
          expired: 0n,
          volume: '10',
        },
      ],
      zkWindows: [
        {
          current: true,
          count: 1n,
          succeeded: 1n,
          expired: 0n,
          volume: '10',
          fees: '0.001',
        },
      ],
    });

    const result = await service.series(consumer, 'month');

    // Something settled and no price to value it: null, never a zero that looks like data.
    expect(result.zkPayments.buckets[11].volumeUsd).toBeNull();
    expect(result.zkPayments.buckets[10].volumeUsd).toBe('0.00');
    expect(result.zkPayments.totals).toMatchObject({
      volume: '10',
      volumeUsd: null,
      fees: '0.001',
      feesUsd: null,
    });
    expect(result.zkPayments.previous).toMatchObject({
      volumeUsd: '0.00',
      feesUsd: '0.00',
    });
  });

  it('values each bucket and both windows in USD, counting what no price covers', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build(
      {
        settled: [
          // this window: October (XLM and Circle's USDC) and November 2025 (an unlisted token)
          {
            bucket: new Date('2026-10-01T00:00:00Z'),
            chain: 'stellar',
            asset: 'XLM',
            issuer: null,
            amount: '40',
            count: 2n,
          },
          {
            bucket: new Date('2026-10-01T00:00:00Z'),
            chain: 'stellar',
            asset: 'USDC',
            issuer: STELLAR_USDC_ISSUER,
            amount: '12.5',
            count: 1n,
          },
          {
            bucket: new Date('2025-11-01T00:00:00Z'),
            chain: 'stellar',
            asset: 'AQUA',
            issuer: 'GUNLISTED',
            amount: '900',
            count: 3n,
          },
          // the window before
          {
            bucket: new Date('2025-06-01T00:00:00Z'),
            chain: 'stellar',
            asset: 'USDC',
            issuer: STELLAR_USDC_ISSUER,
            amount: '8',
            count: 1n,
          },
        ],
      },
      TOKENS,
    );

    const result = await service.series(consumer, 'month');

    expect(result.buckets[11].volumeUsd).toBe('22.50');
    // A bucket of unpriced payments is worth zero dollars; its payments are counted.
    expect(result.buckets[0].volumeUsd).toBe('0.00');
    expect(result.buckets[5].volumeUsd).toBe('0.00');
    expect(result.totals).toMatchObject({ volumeUsd: '22.50', unpriced: 3 });
    expect(result.previous).toMatchObject({ volumeUsd: '8.00', unpriced: 0 });
    // Settled payments only, of both windows, per bucket, asset and issuer.
    const settled = queryOf(queryRaw, 8);
    expect(settled.sql).toContain(`date_trunc('month', "createdAt") AS bucket`);
    expect(settled.sql).toContain('"assetIssuer" AS issuer');
    expect(settled.sql).toContain(`AND "status" = 'SUCCEEDED'`);
    expect(settled.sql).toContain('GROUP BY 1, 2, 3, 4');
    expect(settled.values).toEqual(['c1', 'public', PREVIOUS_SINCE]);
  });

  it('values what the completed swaps sold, per bucket and window, counting what no price covers', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, queryRaw } = build(
      {
        swapSettled: [
          // this window: October, XLM sold on the DEX and a cross-chain swap from Ethereum
          {
            bucket: new Date('2026-10-01T00:00:00Z'),
            chain: 'stellar',
            asset: 'native',
            issuer: null,
            amount: '40',
            count: 2n,
          },
          {
            bucket: new Date('2026-10-01T00:00:00Z'),
            chain: 'eth',
            asset: 'ETH',
            issuer: null,
            amount: '1',
            count: 1n,
          },
          // the window before
          {
            bucket: new Date('2025-06-01T00:00:00Z'),
            chain: 'stellar',
            asset: 'USDC',
            issuer: STELLAR_USDC_ISSUER,
            amount: '8',
            count: 1n,
          },
        ],
      },
      TOKENS,
    );

    const result = await service.series(consumer, 'month');

    // 40 XLM at the price the payments test reads (22.50 - 12.50 for 40 XLM).
    expect(result.swaps.buckets[11].volumeUsd).toBe('10.00');
    expect(result.swaps.buckets[10].volumeUsd).toBe('0.00');
    // A network this service does not price is left out and counted.
    expect(result.swaps.totals).toMatchObject({
      volumeUsd: '10.00',
      unpriced: 1,
    });
    expect(result.swaps.previous).toMatchObject({ volumeUsd: '8.00' });
    // Completed swaps only, of both windows, per bucket and sold asset.
    const settled = queryOf(queryRaw, 9);
    expect(settled.sql).toContain(`WHERE "outcome" = 'succeeded'`);
    expect(settled.sql).toContain('GROUP BY 1, 2, 3, 4');
  });

  it('answers the series without USD values when NEAR Intents’ prices cannot be read', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service } = build({
      settled: [
        {
          bucket: new Date('2026-10-01T00:00:00Z'),
          chain: 'stellar',
          asset: 'XLM',
          issuer: null,
          amount: '40',
          count: 2n,
        },
      ],
    });

    const result = await service.series(consumer, 'month');

    // Only the bucket that had something to value has no value; a quiet one is still zero.
    expect(result.buckets[11].volumeUsd).toBeNull();
    expect(result.buckets[10].volumeUsd).toBe('0.00');
    expect(result.totals).toMatchObject({ volumeUsd: null, unpriced: 2 });
    expect(result.previous).toMatchObject({ volumeUsd: '0.00', unpriced: 0 });
  });
});
