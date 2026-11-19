import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pChainClient } from '@/p2p/p2p-chain.client';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const UUID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** Every keyed P2P route, with the scope it requires. */
const KEYED: [
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  scope: string,
][] = [
  ['get', '/v1/p2p/market', 'p2p:read'],
  ['post', '/v1/p2p/transactions', 'p2p:write'],
  ['post', '/v1/p2p/accounts/challenge', 'p2p:write'],
  ['post', '/v1/p2p/accounts', 'p2p:write'],
  ['get', '/v1/p2p/accounts', 'p2p:read'],
  ['get', '/v1/p2p/accounts/acc_1', 'p2p:read'],
  ['patch', '/v1/p2p/accounts/acc_1', 'p2p:write'],
  ['delete', '/v1/p2p/accounts/acc_1', 'p2p:write'],
  ['post', '/v1/p2p/payment-methods', 'p2p:write'],
  ['get', '/v1/p2p/payment-methods', 'p2p:read'],
  ['patch', '/v1/p2p/payment-methods/pm_1', 'p2p:write'],
  ['delete', '/v1/p2p/payment-methods/pm_1', 'p2p:write'],
  ['post', '/v1/p2p/offers', 'p2p:write'],
  ['get', '/v1/p2p/offers', 'p2p:read'],
  ['patch', '/v1/p2p/offers/off_1', 'p2p:write'],
  ['delete', '/v1/p2p/offers/off_1', 'p2p:write'],
  ['post', '/v1/p2p/quotes', 'p2p:write'],
  ['post', '/v1/p2p/orders', 'p2p:write'],
  ['get', '/v1/p2p/orders', 'p2p:read'],
  ['get', `/v1/p2p/orders/${UUID}`, 'p2p:read'],
  ['post', `/v1/p2p/orders/${UUID}/paid`, 'p2p:write'],
  ['post', `/v1/p2p/orders/${UUID}/cancel`, 'p2p:write'],
  ['post', `/v1/p2p/orders/${UUID}/dispute`, 'p2p:write'],
  ['get', '/v1/p2p/merchant/orders', 'p2p:read'],
  ['get', `/v1/p2p/merchant/orders/${UUID}`, 'p2p:read'],
  ['post', '/v1/p2p/merchant/transfer-matches', 'p2p:read'],
  ['post', '/v1/p2p/charges', 'p2p:write'],
  ['get', '/v1/p2p/charges', 'p2p:read'],
  ['get', `/v1/p2p/charges/${UUID}`, 'p2p:read'],
  ['delete', `/v1/p2p/charges/${UUID}`, 'p2p:write'],
  ['post', '/v1/p2p/payouts', 'p2p:write'],
  ['get', '/v1/p2p/payouts', 'p2p:read'],
  ['get', '/v1/p2p/payouts/batch_1', 'p2p:read'],
];

/** The payer's keyless routes. */
const KEYLESS: [method: 'get' | 'post', path: string][] = [
  ['get', `/v1/p2p-checkout/charges/${UUID}`],
  ['post', `/v1/p2p-checkout/charges/${UUID}/orders`],
  ['get', `/v1/p2p-checkout/orders/${UUID}`],
  ['post', `/v1/p2p-checkout/orders/${UUID}/paid`],
  ['post', `/v1/p2p-checkout/orders/${UUID}/cancel`],
];

const ADMIN: [method: 'get' | 'post' | 'patch', path: string][] = [
  ['get', '/v1/admin/p2p/disputes'],
  ['get', `/v1/admin/p2p/orders/${UUID}`],
  ['post', `/v1/admin/p2p/orders/${UUID}/resolution`],
  ['patch', '/v1/admin/p2p/merchants/acc_1'],
];

/**
 * The wiring in front of the P2P market. The tiers come from
 * `test/setup-env.ts` (a fixture deployment on Base Sepolia, none on mainnet),
 * the chain reader and client are replaced, and Prisma is a stub that finds
 * nothing, so no route reaches a node or a database.
 *
 * Every keyed route refuses a caller that skipped the gateway, a key without
 * its scope and the shared public key, and answers a mainnet key with
 * `network_unsupported` (the market runs on no mainnet network here). The
 * payer's routes take no credential: an unknown charge or order is a 404,
 * never a 401 or 403, and an order without its payer token is that 404 too.
 * The admin routes are the platform console's only.
 */
describe('P2P market (e2e)', () => {
  let app: INestApplication;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'local_client' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    p2pCharge: { findUnique: jest.fn().mockResolvedValue(null) },
    p2pOrder: { findFirst: jest.fn().mockResolvedValue(null) },
    p2pAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  const deployment = {
    tier: 'testnet',
    network: 'base',
    name: 'Base',
    chainId: 84532,
    contract: CONTRACT,
    deployBlock: 1n,
    rpcUrl: 'http://unused',
    tokens: [
      {
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
      },
    ],
    confirmations: 2,
    logBlockRange: 500,
  };
  const readerMock = {
    liveDeployments: jest.fn((tier: string) =>
      Promise.resolve(tier === 'testnet' ? [deployment] : []),
    ),
    protocolState: jest.fn().mockResolvedValue({ feeBps: 50, paused: false }),
    requireLive: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(P2pMarketReader)
      .useValue(readerMock)
      .overrideProvider(P2pChainClient)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
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

  const http = () => app.getHttpServer();
  const call = (method: string, path: string) =>
    (request(http()) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ](path);

  const asKey = (
    r: request.Test,
    permissions = 'p2p:read,p2p:write',
    env = 'dev',
  ) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_client')
      .set('x-consumer-role', 'user')
      .set('x-consumer-env', env)
      .set('x-consumer-permissions', permissions);

  const asPublicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-env', 'dev')
      .set('x-consumer-permissions', 'p2p:read,p2p:write');

  describe('the keyed routes', () => {
    it.each(KEYED)(
      '%s %s refuses a caller that skipped the gateway',
      async (method, path) => {
        const res = await call(method, path).send({}).expect(403);
        expect(res.body.code).toBe('gateway_required');
      },
    );

    it.each(KEYED)(
      '%s %s refuses a key without its scope',
      async (method, path, scope) => {
        const other = scope === 'p2p:read' ? 'p2p:write' : 'p2p:read';
        const res = await asKey(call(method, path), other).send({}).expect(403);
        expect(res.body.code).toBe('insufficient_scope');
      },
    );

    it.each(KEYED)(
      '%s %s refuses the shared public key',
      async (method, path) => {
        await asPublicKey(call(method, path)).send({}).expect(403);
      },
    );

    it.each(KEYED.filter(([, path]) => path !== '/v1/p2p/market'))(
      '%s %s answers a mainnet key with network_unsupported',
      async (method, path) => {
        const res = await asKey(call(method, path), undefined, 'prod').send({});
        // A body the pipe refuses is a 400 too; either way the service, not a
        // guard, answered, and it never reached a node.
        expect(res.status).toBe(400);
        expect(['network_unsupported', 'validation_failed']).toContain(
          res.body.code,
        );
      },
    );
  });

  describe('GET /v1/p2p/market', () => {
    it('lists the verified deployments of the key’s tier', async () => {
      const res = await asKey(request(http()).get('/v1/p2p/market')).expect(
        200,
      );
      expect(res.body).toMatchObject({
        tier: 'testnet',
        available: true,
        bondBps: 1000,
        networks: [
          {
            id: 'base',
            chainId: 84532,
            contract: CONTRACT,
            protocolFeeBps: 50,
            tokens: [{ symbol: 'USDC' }],
          },
        ],
      });
      expect(res.body.matcher).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(
        res.body.currencies.map((c: { code: string }) => c.code),
      ).toContain('ARS');
    });

    it('answers available: false where the market does not run', async () => {
      const res = await asKey(
        request(http()).get('/v1/p2p/market'),
        undefined,
        'prod',
      ).expect(200);
      expect(res.body).toMatchObject({
        tier: 'public',
        available: false,
        networks: [],
      });
    });
  });

  describe('the payer’s keyless routes', () => {
    it.each(KEYLESS)(
      '%s %s takes no credential: an unknown id is a 404',
      async (method, path) => {
        const res = await call(method, path)
          .send(
            path.endsWith('/orders')
              ? {
                  rail: 'ar_bank_transfer',
                  payer: {
                    name: 'Juan Gómez',
                    document: '20123456786',
                    email: 'juan@example.com',
                  },
                }
              : {},
          )
          .expect(404);
        expect(res.body.code).toBe('not_found');
        expect(res.headers['cache-control']).toBe('no-store');
      },
    );

    it('never reads an order without its payer token', async () => {
      prismaMock.p2pOrder.findFirst.mockClear();
      await request(http()).get(`/v1/p2p-checkout/orders/${UUID}`).expect(404);
      expect(prismaMock.p2pOrder.findFirst).not.toHaveBeenCalled();
    });

    it('answers a value that is not a charge id without reading the table', async () => {
      prismaMock.p2pCharge.findUnique.mockClear();
      await request(http()).get('/v1/p2p-checkout/charges/nope').expect(404);
      expect(prismaMock.p2pCharge.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('the admin routes', () => {
    it.each(ADMIN)(
      '%s %s refuses an API key: platform console only',
      async (method, path) => {
        const res = await asKey(call(method, path)).send({}).expect(403);
        expect(res.body.code).toBe('admin_console_only');
      },
    );
  });
});
