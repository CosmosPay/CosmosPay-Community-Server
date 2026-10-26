import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { Prisma } from '@generated/prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * `GET /v1/summary/series`: the dashboard chart's payments, swaps (USDT0 transfers included),
 * liquidity operations and webhook deliveries grouped by period, each on the same buckets.
 *
 * The aggregation is the service spec's; this suite pins the wiring in front of it: the
 * gateway gate, the `payments:read` scope, the period the DTO accepts, and the shape that
 * comes back for a key that may read it.
 */
describe('Summary series (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    // Both aggregations come back empty: a window with no payments.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const tenant = (path: string, scopes: string) =>
    get(path)
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', scopes);

  it('refuses a request that skipped the gateway (403)', async () => {
    const res = await get('/v1/summary/series').expect(403);
    expect(res.body.code).toBe('gateway_required');
  });

  it('refuses a gateway request with no consumer (401)', async () => {
    const res = await get('/v1/summary/series')
      .set('x-gateway-secret', SECRET)
      .expect(401);
    expect(res.body.code).toBe('no_authenticated_consumer');
  });

  it('refuses a key without payments:read (403)', async () => {
    await tenant('/v1/summary/series', 'swaps:read').expect(403);
  });

  it('refuses a period it does not group by (400)', async () => {
    await tenant('/v1/summary/series?period=hour', 'payments:read').expect(400);
  });

  it('answers the seeded buckets and totals to a key that may read payments', async () => {
    const res = await tenant(
      '/v1/summary/series?period=month',
      'payments:read',
    ).expect(200);
    expect(res.body.period).toBe('month');
    expect(res.body.buckets).toHaveLength(12);
    expect(res.body.buckets[0]).toEqual({
      start: expect.stringMatching(/^\d{4}-\d{2}-01$/),
      count: 0,
      succeeded: 0,
      failed: 0,
      volume: '0',
    });
    expect(res.body.totals).toEqual({
      count: 0,
      succeeded: 0,
      failed: 0,
      volume: '0',
      payers: 0,
    });
    expect(res.body.previous).toEqual({
      count: 0,
      succeeded: 0,
      failed: 0,
      volume: '0',
    });
    // Swaps on the same buckets as the payments, so the dashboard charts them side by side.
    expect(res.body.swaps.buckets).toHaveLength(12);
    expect(
      res.body.swaps.buckets.map((b: { start: string }) => b.start),
    ).toEqual(res.body.buckets.map((b: { start: string }) => b.start));
    expect(res.body.swaps.buckets[0]).toEqual({
      start: res.body.buckets[0].start,
      count: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(res.body.swaps.totals).toEqual({
      count: 0,
      succeeded: 0,
      failed: 0,
      inProgress: 0,
      byKind: { dex: 0, chain: 0, crossChain: 0, usdt0: 0 },
    });
    expect(res.body.swaps.previous).toEqual({
      count: 0,
      succeeded: 0,
      failed: 0,
    });
    // Liquidity and webhooks per bucket too, each quiet bucket a zero.
    const starts = res.body.buckets.map((b: { start: string }) => b.start);
    expect(res.body.liquidity).toEqual({
      buckets: starts.map((start: string) => ({
        start,
        count: 0,
        succeeded: 0,
        failed: 0,
      })),
      totals: { count: 0, succeeded: 0, failed: 0 },
      previous: { count: 0, succeeded: 0, failed: 0 },
    });
    expect(res.body.webhooks).toEqual({
      buckets: starts.map((start: string) => ({
        start,
        deliveries: 0,
        failed: 0,
      })),
      totals: { deliveries: 0, failed: 0 },
      previous: { deliveries: 0, failed: 0 },
    });
  });

  it('asks a sandbox key for testnet rows only, so it counts no USDT0 transfer', async () => {
    prismaMock.$queryRaw.mockClear();
    const res = await tenant('/v1/summary/series?period=month', 'payments:read')
      .set('x-consumer-env', 'dev')
      .expect(200);
    expect(res.body.swaps.totals.byKind.usdt0).toBe(0);
    const swapQueries = (
      prismaMock.$queryRaw.mock.calls as [string[], ...unknown[]][]
    )
      .map(([strings, ...values]) => new Prisma.Sql(strings, values))
      .filter((query) => query.text.includes('"usdt0_transfer"'));
    // The swap buckets and the swap windows both read the USDT0 table.
    expect(swapQueries).toHaveLength(2);
    for (const query of swapQueries) {
      expect(query.values).toContain('testnet');
      expect(query.values).not.toContain('public');
    }
  });

  it('groups by day when no period is named', async () => {
    const res = await tenant('/v1/summary/series', 'payments:read').expect(200);
    expect(res.body.period).toBe('day');
    expect(res.body.buckets).toHaveLength(30);
    expect(res.body.swaps.buckets).toHaveLength(30);
    expect(res.body.liquidity.buckets).toHaveLength(30);
    expect(res.body.webhooks.buckets).toHaveLength(30);
  });

  it('aggregates in Postgres and never fetches a row of any model it counts', async () => {
    prismaMock.$queryRaw.mockClear();
    await tenant('/v1/summary/series?period=week', 'payments:read').expect(200);
    // Payments, swaps, liquidity and webhooks, each per bucket and per window; the mock has
    // no `findMany` on any of those models, so fetching rows would have been a 500.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(8);
  });
});
