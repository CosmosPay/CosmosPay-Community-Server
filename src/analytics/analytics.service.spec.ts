import { ConsumerResolverService } from '../common/services/consumer-resolver.service';
import { AnalyticsService } from './analytics.service';
import type { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';

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
  const sqlOf = (queryRaw: jest.Mock, nth: number): string =>
    (queryRaw.mock.calls[nth][0] as string[]).join('?').replace(/\s+/g, ' ');

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

  it('folds the native alias onto XLM in SQL, not in JS', async () => {
    // The fold has to happen inside the GROUP BY. Folding it afterwards in JS
    // meant adding two exact numerics back through `Number`, which is the one
    // thing `formatNumericAmount` exists to prevent.
    const { service, prisma } = build([[], [], [{ payers: 0n }]]);

    await service.summary(consumer);

    const sql = sqlOf(prisma.$queryRaw, 0);
    expect(sql).toContain(`CASE WHEN "asset" IN ('', 'native') THEN 'XLM'`);
    expect(sql).toContain('GROUP BY 1');
  });

  it('passes an aggregated row straight through and tolerates a null sum', async () => {
    const { service } = build([
      [{ asset: 'XLM', amount: null, count: 0n }],
      [],
      [{ payers: 0n }],
    ]);

    const result = await service.summary(consumer);

    expect(result.volume).toEqual([{ asset: 'XLM', amount: '0', count: 0 }]);
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
          asset: 'USDC',
          settled: '90071992547409.9100000',
          pending: '0.1000000',
          settled_count: 2n,
        },
      ],
    ]);

    const result = await service.balances(consumer);

    const sql = sqlOf(prisma.$queryRaw, 0);
    expect(sql).toContain(`CASE WHEN "asset" IN ('', 'native') THEN 'XLM'`);
    expect(sql).toContain('GROUP BY 1');
    // Ordering is the database's job too — a JS sort would have to parse the
    // amounts back to numbers to compare them.
    expect(sql).toContain('ORDER BY');
    expect(result.data[0].amount).toBe('90071992547409.91');
    expect(result.data[0].pending).toBe('0.1');
  });
});
