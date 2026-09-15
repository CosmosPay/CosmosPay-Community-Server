import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The guards in front of /v1/liquidity-pools, with Horizon and the database
 * mocked away. A `400` means the request got past every guard and was refused by
 * validation — every "reaches" case is built to fail validation before a Horizon
 * call, so no case needs the network.
 *
 * Two things are pinned. Every route accepts either its `liquidity:*` scope or
 * the matching `swaps:*` one, because keys issued before pools existed carry only
 * the latter. And the shared public key reaches the routes that build envelopes
 * or read public ledger data, but not the two that replay this consumer's own
 * operations — which, under one shared consumer, would be every anonymous
 * wallet's operations.
 */
describe('Liquidity pools guards (e2e)', () => {
  let app: INestApplication;

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const OP_ID = '0b7e4f2c-8d1a-4e6b-9c3f-5a2d7e8f9a0b';

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    liquidityPoolOperation: {
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

    app = moduleRef.createNestApplication();
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
    prismaMock.liquidityPoolOperation.findMany.mockClear();
    prismaMock.liquidityPoolOperation.findFirst.mockClear();
  });

  type Route = readonly [method: 'get' | 'post', path: string];
  const BASE = '/v1/liquidity-pools';
  const DEPOSIT: Route = ['post', `${BASE}/deposit`];
  const WITHDRAW: Route = ['post', `${BASE}/withdraw`];
  const SUBMIT: Route = ['post', `${BASE}/operations/${OP_ID}/submit`];
  // No `account`: the query DTO requires one, so this stops at validation.
  const POSITIONS: Route = ['get', `${BASE}/positions`];
  // `limit` is 1..100, so 0 stops at validation instead of reaching Horizon.
  const POOLS: Route = ['get', `${BASE}?limit=0`];
  // Not a 64-char hex id: refused before the pool is fetched.
  const POOL: Route = ['get', `${BASE}/not-a-pool-id`];
  const OPERATIONS: Route = ['get', `${BASE}/operations`];
  const OPERATION: Route = ['get', `${BASE}/operations/${OP_ID}`];

  const WRITES = [DEPOSIT, WITHDRAW, SUBMIT];
  const PUBLIC_READS = [POSITIONS, POOLS, POOL];
  const TENANT_READS = [OPERATIONS, OPERATION];
  const ALL = [...WRITES, ...PUBLIC_READS, ...TENANT_READS];

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
   * The shared public key, holding the swaps scopes it is provisioned with.
   * PublicKeyGuard must recognise it by EITHER signal alone: the forwarded role,
   * or the configured `APISIX_PUBLIC_CONSUMER` with the role header lost (see
   * test/setup-env.ts).
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
    for (const route of WRITES) {
      it(`${label(route)} refuses a key holding only read scopes (403)`, async () => {
        const res = await tenant(route, 'liquidity:read,swaps:read').expect(
          403,
        );
        expect(res.body.code).toBe('insufficient_scope');
      });

      it.each(['liquidity:write', 'swaps:write'])(
        `${label(route)} accepts a key holding only %s`,
        async (scope) => {
          const res = await tenant(route, scope).expect(400);
          expect(res.body.code).toBe('validation_failed');
        },
      );
    }

    for (const route of [...PUBLIC_READS, ...TENANT_READS]) {
      it(`${label(route)} refuses a key holding only write scopes (403)`, async () => {
        const res = await tenant(route, 'liquidity:write,swaps:write').expect(
          403,
        );
        expect(res.body.code).toBe('insufficient_scope');
      });
    }

    it.each(['liquidity:read', 'swaps:read'])(
      'lists operations with a key holding only %s, scoped to that consumer',
      async (scope) => {
        const res = await tenant(OPERATIONS, scope).expect(200);

        expect(res.body).toMatchObject({ data: [], total: 0 });
        expect(prismaMock.liquidityPoolOperation.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { consumer: { apisixUsername: 'cosmos_u1' } },
          }),
        );
      },
    );

    it('reads one operation only under its own consumer (404 otherwise)', async () => {
      const res = await tenant(OPERATION, 'liquidity:read').expect(404);

      expect(res.body.code).toBe('not_found');
      expect(prismaMock.liquidityPoolOperation.findFirst).toHaveBeenCalledWith({
        where: { id: OP_ID, consumer: { apisixUsername: 'cosmos_u1' } },
      });
    });
  });

  describe.each(PUBLIC_KEY_IDENTITIES)(
    'the shared public key, recognised %s',
    (_signal, identity) => {
      for (const route of [...WRITES, ...PUBLIC_READS]) {
        it(`reaches ${label(route)} (400 from validation, not 403)`, async () => {
          const res = await publicKey(route, identity).expect(400);
          expect(res.body.code).toBe('validation_failed');
        });
      }

      for (const route of TENANT_READS) {
        it(`is refused ${label(route)} before any operation is read (403)`, async () => {
          const res = await publicKey(route, identity).expect(403);

          expect(res.body.code).toBe('insufficient_scope');
          expect(res.body.message).toMatch(/shared public API key/);
          expect(
            prismaMock.liquidityPoolOperation.findMany,
          ).not.toHaveBeenCalled();
          expect(
            prismaMock.liquidityPoolOperation.findFirst,
          ).not.toHaveBeenCalled();
        });
      }
    },
  );
});
