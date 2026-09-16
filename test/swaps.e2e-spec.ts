import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';
import { SWAP_SUBMIT_RATE_LIMIT } from '@/swaps/swaps.constants';

/**
 * The guards in front of /v1/swaps, with Horizon and the database mocked away.
 * Every assertion is a decision a guard makes: a `400` means the request got
 * past all of them and was refused by validation, so no case needs the network.
 *
 * The case that matters is the shared public key. `POST /v1/swaps/quote` needs
 * `swaps:read` — the same scope that lists swap history — so scopes cannot keep
 * one anonymous wallet out of every other anonymous wallet's swaps. Only
 * `@AllowPublicKey()` does, and a route that loses it, or a read that gains it,
 * fails here.
 *
 * The submit route is also rate limited, because a rejected broadcast costs a
 * Horizon submission and a webhook an error cannot refund — and under the
 * shared public key, the client address is the only thing that can do it.
 */
describe('Swaps guards (e2e)', () => {
  let app: NestExpressApplication;

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const SWAP_ID = '6f1c7e0a-3b5d-4c2e-9a8f-1d2e3f4a5b6c';

  /**
   * The rate limiter's counter. Keyed by bucket alone, not by window: a
   * one-minute window would now and then roll over in the middle of a test, and
   * the window arithmetic is rate-limit.service.spec's to pin, not this suite's.
   */
  const counters = new Map<string, number>();

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    $queryRaw: jest.fn((_sql: unknown, key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return Promise.resolve([{ count: next }]);
    }),
    swap: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // As main.ts does: the address a limit keys on is the one APISIX appends.
    app.set('trust proxy', 1);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // As main.ts does. Without it a ValidationPipe 400 carries no `code`, and
    // the envelope integrators branch on would go untested.
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prismaMock.swap.findMany.mockClear();
    prismaMock.swap.findFirst.mockClear();
    counters.clear();
  });

  type Route = readonly [method: 'get' | 'post', path: string];
  const QUOTE: Route = ['post', '/v1/swaps/quote'];
  const CREATE: Route = ['post', '/v1/swaps'];
  const LIST: Route = ['get', '/v1/swaps'];
  const GET_ONE: Route = ['get', `/v1/swaps/${SWAP_ID}`];
  const SUBMIT: Route = ['post', `/v1/swaps/${SWAP_ID}/submit`];
  const ALL = [QUOTE, CREATE, LIST, GET_ONE, SUBMIT];

  const label = ([method, path]: Route) => `${method.toUpperCase()} ${path}`;

  /** A bare request; a POST carries an empty body, which no DTO here accepts. */
  const call = ([method, path]: Route) =>
    method === 'post'
      ? request(app.getHttpServer()).post(path).send({})
      : request(app.getHttpServer()).get(path);

  /** An ordinary tenant key holding `scopes`. */
  const tenant = (route: Route, scopes: string) =>
    call(route)
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', scopes);

  /**
   * The shared public key, holding every swaps scope. PublicKeyGuard must
   * recognise it by EITHER signal alone, so both are exercised: the role APISIX
   * forwards, and the configured `APISIX_PUBLIC_CONSUMER` with the role header
   * lost (see test/setup-env.ts).
   */
  const PUBLIC_KEY_IDENTITIES = [
    [
      'by the forwarded role',
      { 'x-consumer-username': 'cosmos_wallet', 'x-consumer-role': 'public' },
    ],
    [
      'by the configured consumer name',
      { 'x-consumer-username': 'cosmos_public' },
    ],
  ] as const;

  const publicKey = (route: Route, identity: Record<string, string>) =>
    call(route)
      .set('x-gateway-secret', SECRET)
      .set(identity)
      .set('x-consumer-permissions', 'swaps:read,swaps:write');

  describe('the gateway gate', () => {
    for (const route of ALL) {
      it(`${label(route)} refuses a request that skipped the gateway (403)`, async () => {
        const res = await call(route).expect(403);
        expect(res.body.code).toBe('gateway_required');
      });

      it(`${label(route)} refuses a gateway request with no consumer (401)`, async () => {
        const res = await call(route)
          .set('x-gateway-secret', SECRET)
          .expect(401);
        expect(res.body.code).toBe('no_authenticated_consumer');
      });
    }
  });

  describe('scopes', () => {
    const wrongScope: [Route, string][] = [
      [QUOTE, 'swaps:write'],
      [CREATE, 'swaps:read'],
      [LIST, 'swaps:write'],
      [GET_ONE, 'swaps:write'],
      [SUBMIT, 'swaps:read'],
    ];

    for (const [route, scope] of wrongScope) {
      it(`${label(route)} refuses a key holding only ${scope} (403)`, async () => {
        const res = await tenant(route, scope).expect(403);
        expect(res.body.code).toBe('insufficient_scope');
      });
    }
  });

  describe('an ordinary key with the scope', () => {
    const writes: [Route, string][] = [
      [QUOTE, 'swaps:read'],
      [CREATE, 'swaps:write'],
      [SUBMIT, 'swaps:write'],
    ];

    for (const [route, scope] of writes) {
      it(`reaches ${label(route)} (400 from validation)`, async () => {
        const res = await tenant(route, scope).expect(400);
        expect(res.body.code).toBe('validation_failed');
      });
    }

    it('lists only its own swaps', async () => {
      const res = await tenant(LIST, 'swaps:read').expect(200);

      expect(res.body).toMatchObject({ data: [], total: 0 });
      expect(prismaMock.swap.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { consumer: { apisixUsername: 'cosmos_u1' } },
        }),
      );
    });

    it('reads one swap only under its own consumer (404 otherwise)', async () => {
      const res = await tenant(GET_ONE, 'swaps:read').expect(404);

      expect(res.body.code).toBe('not_found');
      expect(prismaMock.swap.findFirst).toHaveBeenCalledWith({
        where: { id: SWAP_ID, consumer: { apisixUsername: 'cosmos_u1' } },
      });
    });
  });

  describe.each(PUBLIC_KEY_IDENTITIES)(
    'the shared public key, recognised %s',
    (_signal, identity) => {
      for (const route of [QUOTE, CREATE, SUBMIT]) {
        it(`reaches ${label(route)} (400 from validation, not 403)`, async () => {
          const res = await publicKey(route, identity).expect(400);
          expect(res.body.code).toBe('validation_failed');
        });
      }

      for (const route of [LIST, GET_ONE]) {
        it(`is refused ${label(route)} before any swap is read (403)`, async () => {
          const res = await publicKey(route, identity).expect(403);

          expect(res.body.code).toBe('insufficient_scope');
          expect(res.body.message).toMatch(/shared public API key/);
          expect(prismaMock.swap.findMany).not.toHaveBeenCalled();
          expect(prismaMock.swap.findFirst).not.toHaveBeenCalled();
        });
      }
    },
  );

  describe(`the rate limit on ${label(SUBMIT)}`, () => {
    const { limit } = SWAP_SUBMIT_RATE_LIMIT;
    const ADDRESS = '203.0.113.7';

    /**
     * An anonymous wallet on the shared public key, from `address` as APISIX
     * forwards it. The body is well-formed, so an allowed call reaches the
     * service and comes back 404 (no such swap under this consumer).
     */
    const anonymousSubmit = (address: string) =>
      request(app.getHttpServer())
        .post(SUBMIT[1])
        .set('x-gateway-secret', SECRET)
        .set(PUBLIC_KEY_IDENTITIES[0][1])
        .set('x-consumer-permissions', 'swaps:write')
        .set('x-forwarded-for', address)
        .send({ signedXdr: 'AAAA' });

    const spend = async (address: string, calls: number) => {
      for (let i = 0; i < calls; i++) {
        await anonymousSubmit(address).expect(404);
      }
    };

    it('reports the budget of its own policy', async () => {
      const res = await anonymousSubmit(ADDRESS).expect(404);

      expect(res.headers['ratelimit-limit']).toBe(String(limit));
      expect(res.headers['ratelimit-remaining']).toBe(String(limit - 1));
    });

    it('refuses an address past its budget before the swap is read (429)', async () => {
      await spend(ADDRESS, limit);
      prismaMock.swap.findFirst.mockClear();

      const refused = await anonymousSubmit(ADDRESS).expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(prismaMock.swap.findFirst).not.toHaveBeenCalled();
    });

    it('keeps anonymous wallets on different addresses apart', async () => {
      // One shared consumer, so the address is the only thing separating them.
      await spend(ADDRESS, limit);
      await anonymousSubmit(ADDRESS).expect(429);

      await anonymousSubmit('198.51.100.4').expect(404);
    });

    it('does not spend the budget of the routes that build swaps', async () => {
      await spend(ADDRESS, limit);
      await anonymousSubmit(ADDRESS).expect(429);

      const res = await publicKey(CREATE, PUBLIC_KEY_IDENTITIES[0][1])
        .set('x-forwarded-for', ADDRESS)
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });
});
