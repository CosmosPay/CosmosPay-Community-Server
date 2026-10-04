import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { CROSS_CHAIN_DEPOSIT_RATE_LIMIT } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The guards in front of /v1/cross-chain-swaps, with NEAR Intents and the
 * database mocked away. A `400` means a request got past every guard and was
 * refused by validation, so no case needs the network.
 *
 * As for /v1/swaps, the case that matters is the shared public key: the routes
 * an anonymous wallet needs (assets, quote, create, deposit) admit it, and the
 * two that read history back refuse it — one consumer is every anonymous user.
 */
describe('Cross-chain swaps guards (e2e)', () => {
  let app: NestExpressApplication;

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const SWAP_ID = 'cm1x2y3z4a5b6c7d8e9f0g1h2';

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
    crossChainSwap: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const nearIntentsMock = {
    tokens: jest.fn().mockResolvedValue([
      { assetId: 'xlm', decimals: 7, blockchain: 'stellar', symbol: 'XLM' },
      { assetId: 'btc', decimals: 8, blockchain: 'btc', symbol: 'BTC' },
    ]),
    quote: jest.fn(),
    status: jest.fn(),
    submitDeposit: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(NearIntentsClient)
      .useValue(nearIntentsMock)
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
    prismaMock.crossChainSwap.findMany.mockClear();
    prismaMock.crossChainSwap.findFirst.mockClear();
    nearIntentsMock.quote.mockClear();
    counters.clear();
  });

  type Route = readonly [method: 'get' | 'post', path: string];
  const ASSETS: Route = ['get', '/v1/cross-chain-swaps/assets'];
  const QUOTE: Route = ['post', '/v1/cross-chain-swaps/quote'];
  const CREATE: Route = ['post', '/v1/cross-chain-swaps'];
  const LIST: Route = ['get', '/v1/cross-chain-swaps'];
  const GET_ONE: Route = ['get', `/v1/cross-chain-swaps/${SWAP_ID}`];
  const DEPOSIT: Route = ['post', `/v1/cross-chain-swaps/${SWAP_ID}/deposit`];
  const ALL = [ASSETS, QUOTE, CREATE, LIST, GET_ONE, DEPOSIT];

  const label = ([method, path]: Route) => `${method.toUpperCase()} ${path}`;

  const call = ([method, path]: Route) =>
    method === 'post'
      ? request(app.getHttpServer()).post(path).send({})
      : request(app.getHttpServer()).get(path);

  const tenant = (route: Route, scopes: string) =>
    call(route)
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', scopes);

  const PUBLIC_KEY = {
    'x-consumer-username': 'cosmos_wallet',
    'x-consumer-role': 'public',
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
      [ASSETS, 'swaps:write'],
      [QUOTE, 'swaps:write'],
      [CREATE, 'swaps:read'],
      [LIST, 'swaps:write'],
      [GET_ONE, 'swaps:write'],
      [DEPOSIT, 'swaps:read'],
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
      [DEPOSIT, 'swaps:write'],
    ] as [Route, string][]) {
      it(`reaches ${label(route)} (400 from validation)`, async () => {
        const res = await tenant(route, scope).expect(400);
        expect(res.body.code).toBe('validation_failed');
      });
    }

    it('lists only the assets on the chains this service knows', async () => {
      const res = await tenant(ASSETS, 'swaps:read').expect(200);
      expect(res.body.data).toEqual([
        {
          chain: 'stellar',
          symbol: 'XLM',
          assetId: 'xlm',
          decimals: 7,
          contract: null,
        },
      ]);
    });

    it('sends Stellar → Stellar to the native DEX without asking NEAR Intents', async () => {
      const res = await tenant(QUOTE, 'swaps:read')
        .send({
          originChain: 'stellar',
          originAsset: 'XLM',
          destinationChain: 'stellar',
          destinationAsset: 'USDC',
          amount: '10',
          recipient: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
          refundTo: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
        })
        .expect(400);
      expect(res.body.message).toContain('/v1/swaps');
      expect(nearIntentsMock.quote).not.toHaveBeenCalled();
    });

    it('validates each address against its own chain', async () => {
      const res = await tenant(QUOTE, 'swaps:read')
        .send({
          originChain: 'solana',
          originAsset: 'SOL',
          destinationChain: 'monad',
          destinationAsset: 'MON',
          amount: '1',
          // A Stellar address where a Monad one belongs, and vice versa.
          recipient: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
          refundTo: '0x76b4c56085ED136a8744D52bE956396624a730E8',
        })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.message.join(' ')).toMatch(/recipient.*monad/i);
      expect(res.body.message.join(' ')).toMatch(/refundTo.*solana/i);
    });

    it('lists only its own swaps', async () => {
      const res = await tenant(LIST, 'swaps:read').expect(200);
      expect(res.body).toMatchObject({ data: [], total: 0 });
      expect(prismaMock.crossChainSwap.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { consumer: { apisixUsername: 'cosmos_u1' } },
        }),
      );
    });

    it('reads one swap only under its own consumer (404 otherwise)', async () => {
      const res = await tenant(GET_ONE, 'swaps:read').expect(404);
      expect(res.body.code).toBe('not_found');
      expect(prismaMock.crossChainSwap.findFirst).toHaveBeenCalledWith({
        where: { id: SWAP_ID, consumer: { apisixUsername: 'cosmos_u1' } },
      });
    });
  });

  describe('the shared public key', () => {
    for (const route of [QUOTE, CREATE, DEPOSIT]) {
      it(`reaches ${label(route)} (400 from validation, not 403)`, async () => {
        const res = await publicKey(route).expect(400);
        expect(res.body.code).toBe('validation_failed');
      });
    }

    it(`reaches ${label(ASSETS)}`, async () => {
      await publicKey(ASSETS).expect(200);
    });

    for (const route of [LIST, GET_ONE]) {
      it(`is refused ${label(route)} before any swap is read (403)`, async () => {
        const res = await publicKey(route).expect(403);
        expect(res.body.code).toBe('insufficient_scope');
        expect(prismaMock.crossChainSwap.findMany).not.toHaveBeenCalled();
        expect(prismaMock.crossChainSwap.findFirst).not.toHaveBeenCalled();
      });
    }
  });

  describe(`the rate limit on ${label(DEPOSIT)}`, () => {
    const { limit } = CROSS_CHAIN_DEPOSIT_RATE_LIMIT;
    const ADDRESS = '203.0.113.7';

    const anonymousDeposit = (address: string) =>
      request(app.getHttpServer())
        .post(DEPOSIT[1])
        .set('x-gateway-secret', SECRET)
        .set(PUBLIC_KEY)
        .set('x-consumer-permissions', 'swaps:write')
        .set('x-forwarded-for', address)
        .send({ txHash: 'ab'.repeat(32) });

    it('refuses an address past its budget before the swap is read (429)', async () => {
      for (let i = 0; i < limit; i++) {
        await anonymousDeposit(ADDRESS).expect(404);
      }
      prismaMock.crossChainSwap.findFirst.mockClear();

      const refused = await anonymousDeposit(ADDRESS).expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(prismaMock.crossChainSwap.findFirst).not.toHaveBeenCalled();
      await anonymousDeposit('198.51.100.4').expect(404);
    });
  });
});
