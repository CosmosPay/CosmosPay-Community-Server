import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { recordToken, recordTokenKey } from '@/common/public-record-token';
import { PrismaService } from '@/prisma/prisma.service';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';
import { USDT0_SUBMIT_RATE_LIMIT } from '@/usdt0/usdt0.constants';

/**
 * The guards in front of /v1/usdt0, with the Soroban RPC, LayerZero Scan and
 * the database mocked away. A `400` means a request got past every guard and
 * was refused by validation, so no case needs the network.
 *
 * As for swaps, the case that matters is the shared public key: every route an
 * anonymous wallet needs (routes, quote, create, submit, and reading the one
 * transfer it holds the id of) admits it, and the list refuses it, because one
 * consumer is every anonymous user. A dev key is refused on what would touch
 * mainnet, before the RPC is asked.
 */
describe('USDT0 guards (e2e)', () => {
  let app: NestExpressApplication;

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const TRANSFER_ID = 'cm2u0t0transfer0000000001';

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
    usdt0Transfer: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const rpcMock = {
    passphrase: 'Public Global Stellar Network ; September 2015',
    simulate: jest.fn(),
    send: jest.fn(),
    getTransaction: jest.fn(),
  };
  const scanMock = { byGuid: jest.fn(), byTransaction: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(SorobanRpcClient)
      .useValue(rpcMock)
      .overrideProvider(LayerZeroScanClient)
      .useValue(scanMock)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
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
    prismaMock.usdt0Transfer.findMany.mockClear();
    prismaMock.usdt0Transfer.findFirst.mockClear();
    rpcMock.simulate.mockClear();
    counters.clear();
  });

  type Route = readonly [method: 'get' | 'post', path: string];
  const ROUTES: Route = ['get', '/v1/usdt0/routes'];
  const QUOTE: Route = ['post', '/v1/usdt0/quote'];
  const CREATE: Route = ['post', '/v1/usdt0/transfers'];
  const LIST: Route = ['get', '/v1/usdt0/transfers'];
  const GET_ONE: Route = ['get', `/v1/usdt0/transfers/${TRANSFER_ID}`];
  const SUBMIT: Route = ['post', `/v1/usdt0/transfers/${TRANSFER_ID}/submit`];
  const ALL = [ROUTES, QUOTE, CREATE, LIST, GET_ONE, SUBMIT];

  const label = ([method, path]: Route) => `${method.toUpperCase()} ${path}`;

  const call = ([method, path]: Route) =>
    method === 'post'
      ? request(app.getHttpServer()).post(path).send({})
      : request(app.getHttpServer()).get(path);

  const tenant = (route: Route, scopes: string) =>
    call(route)
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-env', 'prod')
      .set('x-consumer-permissions', scopes);

  const PUBLIC_KEY = {
    'x-consumer-username': 'cosmos_wallet',
    'x-consumer-role': 'public',
    'x-consumer-env': 'prod',
  };
  const publicKey = (route: Route) =>
    call(route)
      .set('x-gateway-secret', SECRET)
      .set(PUBLIC_KEY)
      .set('x-consumer-permissions', 'swaps:read,swaps:write');

  describe('the gateway gate', () => {
    for (const route of ALL) {
      it(`${label(route)} refuses a request that skipped the gateway (403)`, async () => {
        const res = await call(route).expect(403);
        expect(res.body.code).toBe('gateway_required');
      });
    }
  });

  describe('scopes', () => {
    const wrongScope: [Route, string][] = [
      [ROUTES, 'swaps:write'],
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
    for (const [route, scope] of [
      [QUOTE, 'swaps:read'],
      [CREATE, 'swaps:write'],
      [SUBMIT, 'swaps:write'],
    ] as [Route, string][]) {
      it(`reaches ${label(route)} (400 from validation)`, async () => {
        const res = await tenant(route, scope).expect(400);
        expect(res.body.code).toBe('validation_failed');
      });
    }

    it('lists the routes on mainnet', async () => {
      const res = await tenant(ROUTES, 'swaps:read').expect(200);
      expect(res.body).toMatchObject({
        network: 'public',
        available: true,
        eid: 30600,
        oft: 'CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6',
      });
      expect(res.body.routes[0]).toEqual({
        chain: 'eth',
        name: 'Ethereum',
        eid: 30101,
        receives: 'USDT',
      });
    });

    it('refuses a route that does not exist and a non-EVM recipient', async () => {
      const res = await tenant(CREATE, 'swaps:write')
        .send({
          source: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
          to: 'tron',
          recipient: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          amount: '10',
        })
        .expect(400);
      const messages = (res.body.message as string[]).join(' ');
      expect(messages).toMatch(/to must be one of/);
      expect(messages).toMatch(/recipient must be an EVM address/);
      expect(rpcMock.simulate).not.toHaveBeenCalled();
    });

    it('validates a nested merchantFee, and refuses one with no wrapper configured before the RPC', async () => {
      const body = {
        source: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
        to: 'eth',
        recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        amount: '10',
      };
      const wallet = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
      const bad = await tenant(CREATE, 'swaps:write')
        .send({ ...body, merchantFee: { bps: 100, wallet, paidBy: 'nobody' } })
        .expect(400);
      expect(bad.body.code).toBe('validation_failed');
      expect(JSON.stringify(bad.body)).toContain('paidBy');

      const unsupported = await tenant(CREATE, 'swaps:write')
        .send({ ...body, merchantFee: { bps: 100, wallet } })
        .expect(400);
      expect(unsupported.body.code).toBe('merchant_fee_unsupported');
      expect(rpcMock.simulate).not.toHaveBeenCalled();
    });

    it('lists only its own transfers', async () => {
      const res = await tenant(LIST, 'swaps:read').expect(200);
      expect(res.body).toMatchObject({ data: [], total: 0 });
      expect(prismaMock.usdt0Transfer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // The key's network (prod: mainnet, where USDT0 lives).
          where: {
            consumer: { apisixUsername: 'cosmos_u1' },
            network: 'public',
          },
        }),
      );
    });
  });

  describe('a dev (testnet) key', () => {
    const dev = (route: Route, scopes: string) =>
      call(route)
        .set('x-gateway-secret', SECRET)
        .set('x-consumer-username', 'cosmos_u1')
        .set('x-consumer-env', 'dev')
        .set('x-consumer-permissions', scopes);

    it('reads the routes as unavailable, with none listed', async () => {
      const res = await dev(ROUTES, 'swaps:read').expect(200);
      expect(res.body).toMatchObject({ available: false, routes: [] });
    });

    it('is refused a quote before the RPC is asked: mainnet only', async () => {
      const res = await dev(QUOTE, 'swaps:read')
        .send({ to: 'eth', amount: '10' })
        .expect(400);
      expect(res.body.code).toBe('network_unsupported');
      expect(res.body.message).toContain('Stellar mainnet only');
      expect(rpcMock.simulate).not.toHaveBeenCalled();
    });

    it('is refused a transfer', async () => {
      const res = await dev(CREATE, 'swaps:write')
        .send({
          source: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
          to: 'eth',
          recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
          amount: '10',
        })
        .expect(400);
      expect(res.body.code).toBe('network_unsupported');
    });
  });

  describe('the shared public key', () => {
    for (const route of [QUOTE, CREATE, SUBMIT]) {
      it(`reaches ${label(route)} (400 from validation, not 403)`, async () => {
        const res = await publicKey(route).expect(400);
        expect(res.body.code).toBe('validation_failed');
      });
    }

    it(`reaches ${label(ROUTES)}`, async () => {
      await publicKey(ROUTES).expect(200);
    });

    it(`reaches ${label(GET_ONE)} with the transfer's record token, scoped to the public consumer`, async () => {
      const res = await publicKey(GET_ONE)
        .set(
          'X-Record-Token',
          recordToken(recordTokenKey(SECRET), 'usdt0-transfer', TRANSFER_ID),
        )
        .expect(404);
      expect(res.body.code).toBe('not_found');
      expect(prismaMock.usdt0Transfer.findFirst).toHaveBeenCalledWith({
        where: {
          id: TRANSFER_ID,
          consumer: { apisixUsername: 'cosmos_wallet' },
        },
      });
    });

    it(`refuses ${label(GET_ONE)} without the record token, before any transfer is read (404)`, async () => {
      const res = await publicKey(GET_ONE).expect(404);
      expect(res.body.code).toBe('not_found');
      expect(prismaMock.usdt0Transfer.findFirst).not.toHaveBeenCalled();
    });

    it(`is refused ${label(LIST)} before any transfer is read (403)`, async () => {
      const res = await publicKey(LIST).expect(403);
      expect(res.body.code).toBe('insufficient_scope');
      expect(prismaMock.usdt0Transfer.findMany).not.toHaveBeenCalled();
    });
  });

  describe(`the rate limit on ${label(SUBMIT)}`, () => {
    const { limit } = USDT0_SUBMIT_RATE_LIMIT;

    const anonymousSubmit = (address: string) =>
      request(app.getHttpServer())
        .post(SUBMIT[1])
        .set('x-gateway-secret', SECRET)
        .set(PUBLIC_KEY)
        .set('x-consumer-permissions', 'swaps:write')
        .set('x-forwarded-for', address)
        .send({ signedXdr: 'AAAA' });

    it('refuses an address past its budget before the transfer is read (429)', async () => {
      for (let i = 0; i < limit; i++) {
        await anonymousSubmit('203.0.113.9').expect(404);
      }
      prismaMock.usdt0Transfer.findFirst.mockClear();

      const refused = await anonymousSubmit('203.0.113.9').expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(prismaMock.usdt0Transfer.findFirst).not.toHaveBeenCalled();
      await anonymousSubmit('198.51.100.9').expect(404);
    });
  });
});
