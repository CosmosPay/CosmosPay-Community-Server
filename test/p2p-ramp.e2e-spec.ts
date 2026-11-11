import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const SANDBOX_USDT = '0x25f5D414F85b7f4668ADe4E557ef234023208771';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const ARB = '0x912CE59144191C1204E64559FE8253a0e49E6548';
const NATIVE = '0x0000000000000000000000000000000000000000';

const MARKET_COMMON = {
  '/currencies': {
    currencies: [
      { id: 'ARS', type: 'FIAT', description: { en: 'Argentine Pesos' } },
    ],
  },
  '/payment-methods': {
    paymentMethods: [
      { id: 'bank_tx_ar', name: 'Bank Transfer (ARS)', currency: 'ARS' },
    ],
  },
};

/** The marketplace's sandbox answers (trimmed copies of 2026-11-05's). */
const SANDBOX: Record<string, unknown> = {
  ...MARKET_COMMON,
  '/prices': {
    BUY: { ARS: { price: '990.86', limits: { in: { min: '4954.30' } } } },
    SELL: { ARS: { price: '1000', limits: { in: { min: '5' } } } },
  },
  '/chains': { chains: ['421614'] },
  // The sandbox's test USDT has no USD price: it counts as 1 USD.
  '/chains/421614/tokens': {
    tokens: [
      {
        address: SANDBOX_USDT,
        symbol: 'USDT',
        decimals: 18,
        chainId: '421614',
      },
    ],
  },
};

/** Mainnet, two chains (a third whose list fails) and a token with no USD price. */
const MAINNET: Record<string, unknown> = {
  ...MARKET_COMMON,
  '/prices': {
    BUY: { ARS: { price: '1600', limits: { in: { min: '8000' } } } },
    SELL: { ARS: { price: '1625.11', limits: { in: { min: '5' } } } },
  },
  '/chains': { chains: ['42161', '137', '81457'] },
  '/chains/42161/tokens': {
    tokens: [
      {
        address: NATIVE,
        symbol: 'ETH',
        decimals: 18,
        chainId: '42161',
        logo: 'https://example.invalid/eth.png',
        priceUSD: '2000',
      },
      { address: ARB, symbol: 'ARB', decimals: 18, chainId: '42161' },
      {
        address: USDT0,
        symbol: 'USDT0',
        decimals: 6,
        chainId: '42161',
        priceUSD: '1',
      },
    ],
  },
  '/chains/137/tokens': {
    tokens: [
      {
        address: NATIVE,
        symbol: 'POL',
        decimals: 18,
        chainId: '137',
        priceUSD: '0.1',
      },
    ],
  },
  // '/chains/81457/tokens' is missing: the marketplace's error for it.
};

async function boot(prisma: unknown): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = moduleRef.createNestApplication();
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
  return app;
}

const keyed =
  (username: string, role: string, env: string, permissions: string) =>
  (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', username)
      .set('x-consumer-role', role)
      .set('x-consumer-env', env)
      .set('x-consumer-permissions', permissions);

const ALL_SCOPES = 'onramp:read,onramp:write,offramp:read,offramp:write';
/** An ordinary dev key (the sandbox) with the on-ramp and off-ramp scopes. */
const asTenant = keyed('cosmos_alice', 'user', 'dev', ALL_SCOPES);
/** The same tenant with a production key (mainnet). */
const asTenantLive = keyed('cosmos_alice', 'user', 'prod', ALL_SCOPES);
/** A dev key with the on-ramp scopes only. */
const asBuyerOnly = keyed(
  'cosmos_alice',
  'user',
  'dev',
  'onramp:read,onramp:write',
);
/** The shared public key, with every scope a P2P route asks for. */
const asPublicKey = keyed('cosmos_public', 'public', 'dev', ALL_SCOPES);

/**
 * The wiring in front of /v1/onramp/p2p and /v1/offramp/p2p, against the real
 * client with the marketplace's HTTP answered here and no integrator ids
 * configured.
 */
describe('P2P on-ramp and off-ramp (e2e)', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  const requested: string[] = [];

  const prisma = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c_alice' }) },
    p2pRampSession: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'clz_s1', createdAt: new Date(0), ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  beforeAll(async () => {
    const realFetch = global.fetch;
    const hosts: [string, Record<string, unknown>][] = [
      ['https://api-testnet.eldorado.io/api/', SANDBOX],
      ['https://api.eldorado.io/api/', MAINNET],
    ];
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = hosts.find(([prefix]) => url.startsWith(prefix));
        if (!host) return realFetch(input, init);
        requested.push(url);
        const body = host[1][new URL(url).pathname.replace(/^\/api/, '')];
        return new Response(JSON.stringify(body ?? { message: 'error' }), {
          status: body ? 200 : 500,
        });
      });
    app = await boot(prisma);
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    await app.close();
  });

  const http = () => app.getHttpServer();
  const order = {
    currency: 'ARS',
    paymentMethod: 'bank_tx_ar',
    chainId: 421614,
    token: SANDBOX_USDT,
    amount: '6000',
    address: ADDRESS,
  };

  it('refuses a caller that did not come through the gateway', async () => {
    const res = await request(http()).get('/v1/onramp/p2p/market').expect(403);

    expect(res.body.code).toBe('gateway_required');
  });

  it('reads the sandbox market for a dev key', async () => {
    const res = await asTenant(
      request(http()).get('/v1/onramp/p2p/market'),
    ).expect(200);

    expect(res.body.currencies.map((c: { id: string }) => c.id)).toEqual([
      'ARS',
    ]);
    expect(res.body.networks).toEqual([
      { chainId: 421614, name: 'Arbitrum Sepolia', tokenCount: 1 },
    ]);
    expect(res.body.defaultToken).toMatchObject({
      chainId: 421614,
      address: SANDBOX_USDT,
    });
    expect(
      requested.every((u) => u.startsWith('https://api-testnet.eldorado.io/')),
    ).toBe(true);
  });

  it('lets the shared public key buy: read, quote, open and read back its own session, never list', async () => {
    await asPublicKey(request(http()).get('/v1/onramp/p2p/market')).expect(200);
    await asPublicKey(
      request(http()).get('/v1/onramp/p2p/tokens?chainId=421614'),
    ).expect(200);
    // Past the guards: what stops it here is the missing integrator ids.
    const quote = await asPublicKey(
      request(http()).post('/v1/onramp/p2p/quotes').send(order),
    ).expect(503);
    expect(quote.body.code).toBe('misconfigured');

    const opened = await asPublicKey(
      request(http()).post('/v1/onramp/p2p/sessions').send(order),
    ).expect(201);
    expect(opened.body.publicToken).toEqual(expect.any(String));

    const listed = await asPublicKey(
      request(http()).get('/v1/onramp/p2p/sessions'),
    ).expect(403);
    expect(listed.body.code).toBe('insufficient_scope');

    prisma.p2pRampSession.findFirst.mockClear();
    const path = `/v1/onramp/p2p/sessions/${opened.body.id}`;
    await asPublicKey(request(http()).get(path)).expect(404);
    await asPublicKey(
      request(http()).get(path).set('x-record-token', 'not-the-token'),
    ).expect(404);
    expect(prisma.p2pRampSession.findFirst).not.toHaveBeenCalled();

    prisma.p2pRampSession.findFirst.mockResolvedValueOnce({
      id: opened.body.id,
    });
    await asPublicKey(
      request(http()).get(path).set('x-record-token', opened.body.publicToken),
    ).expect(200);
    expect(
      prisma.p2pRampSession.findFirst.mock.calls[0][0].where,
    ).toMatchObject({ id: opened.body.id, side: 'buy' });
  });

  it('gives an account no record token', async () => {
    const res = await asTenant(
      request(http()).post('/v1/onramp/p2p/sessions').send(order),
    ).expect(201);

    expect(res.body).not.toHaveProperty('publicToken');
  });

  it('opens a session with the recipient fixed in the widget URL', async () => {
    prisma.p2pRampSession.create.mockClear();
    const res = await asTenant(
      request(http()).post('/v1/onramp/p2p/sessions').send(order),
    ).expect(201);

    expect(res.body).toMatchObject({
      network: 'testnet',
      chainId: 421614,
      address: ADDRESS,
      token: 'USDT',
      tokenAddress: SANDBOX_USDT,
      // 6000 / 990.86 / 1
      estimatedAmountOut: '6.05',
    });
    const url = new URL(res.body.widgetUrl);
    expect(url.origin).toBe('https://widget-testnet.eldorado.io');
    expect(url.searchParams.get('address')).toBe(ADDRESS);
    expect(url.searchParams.get('token')).toBe(SANDBOX_USDT);
    expect(url.searchParams.get('chain')).toBe('421614');
    expect(prisma.p2pRampSession.create).toHaveBeenCalledTimes(1);
    expect(prisma.p2pRampSession.create.mock.calls[0][0].data.side).toBe('buy');
  });

  it('refuses an order the market does not take, and a recipient or token that is not an EVM address', async () => {
    const below = await asTenant(
      request(http())
        .post('/v1/onramp/p2p/sessions')
        .send({ ...order, amount: '100' }),
    ).expect(400);
    expect(below.body.code).toBe('validation_failed');

    const chain = await asTenant(
      request(http())
        .post('/v1/onramp/p2p/sessions')
        .send({ ...order, chainId: 42161 }),
    ).expect(400);
    expect(chain.body.message).toBe(
      'chainId 42161 is not offered (offered: 421614)',
    );

    await asTenant(
      request(http())
        .post('/v1/onramp/p2p/sessions')
        .send({ ...order, address: 'GABC' }),
    ).expect(400);
    await asTenant(
      request(http())
        .post('/v1/onramp/p2p/sessions')
        .send({ ...order, token: 'USDT' }),
    ).expect(400);
  });

  it('answers 503 for a firm quote while the integrator ids are not configured', async () => {
    const res = await asTenant(
      request(http()).post('/v1/onramp/p2p/quotes').send(order),
    ).expect(503);

    expect(res.body.code).toBe('misconfigured');
    expect(requested.some((u) => u.includes('/quote/buy'))).toBe(false);
  });

  it('answers 404 for a session that is not the caller’s', async () => {
    await asTenant(
      request(http()).get('/v1/onramp/p2p/sessions/clz_other'),
    ).expect(404);
  });

  describe('every chain and token on mainnet', () => {
    const live = {
      ...order,
      chainId: 42161,
      token: USDT0,
      amount: '16000',
    };

    it('offers the chains whose list loads, leaving out the one that fails', async () => {
      const res = await asTenantLive(
        request(http()).get('/v1/onramp/p2p/market'),
      ).expect(200);

      expect(res.body.networks).toEqual([
        { chainId: 42161, name: 'Arbitrum', tokenCount: 3 },
        { chainId: 137, name: 'Polygon', tokenCount: 1 },
      ]);
      expect(res.body.defaultToken.address).toBe(USDT0);
    });

    it('pages and searches a chain’s tokens, its main assets first, each with its listing’s logo', async () => {
      const res = await asTenantLive(
        request(http()).get('/v1/onramp/p2p/tokens?chainId=42161&take=2'),
      ).expect(200);

      expect(res.body.total).toBe(3);
      // Arbitrum's own coin first, then its USD stablecoins (P2P_MAIN_TOKENS).
      expect(res.body.data.map((t: { symbol: string }) => t.symbol)).toEqual([
        'ETH',
        'USDT0',
      ]);
      expect(res.body.data[1]).toEqual({
        chainId: 42161,
        address: USDT0,
        symbol: 'USDT0',
        decimals: 6,
        priceUsd: '1',
        logoUrl: null,
        main: true,
      });
      // The listing's logo, under its own name (never the raw `logo` field).
      expect(res.body.data[0].logoUrl).toBe('https://example.invalid/eth.png');
      expect(res.body.data[0]).not.toHaveProperty('logo');

      const found = await asTenantLive(
        request(http()).get('/v1/offramp/p2p/tokens?chainId=42161&q=ar'),
      ).expect(200);
      expect(found.body.data).toEqual([
        expect.objectContaining({ symbol: 'ARB', priceUsd: null }),
      ]);
    });

    it('refuses a tokens query without a chain, or for one left out', async () => {
      await asTenantLive(request(http()).get('/v1/onramp/p2p/tokens')).expect(
        400,
      );
      const res = await asTenantLive(
        request(http()).get('/v1/onramp/p2p/tokens?chainId=81457'),
      ).expect(400);
      expect(res.body.message).toBe(
        'chainId 81457 is not offered (offered: 42161, 137)',
      );
      await asTenantLive(
        request(http()).get('/v1/onramp/p2p/tokens?chainId=42161&take=201'),
      ).expect(400);
    });

    it('buys a chain’s own coin on another chain, and a token with no USD price without an estimate', async () => {
      prisma.p2pRampSession.create.mockClear();
      const pol = await asTenantLive(
        request(http())
          .post('/v1/onramp/p2p/sessions')
          .send({ ...live, chainId: 137, token: NATIVE }),
      ).expect(201);
      expect(pol.body).toMatchObject({
        network: 'public',
        chainId: 137,
        token: 'POL',
        tokenAddress: NATIVE,
        // 16000 / 1600 / 0.1
        estimatedAmountOut: '100.00',
      });
      expect(new URL(pol.body.widgetUrl).searchParams.get('chain')).toBe('137');

      const arb = await asTenantLive(
        request(http())
          .post('/v1/onramp/p2p/sessions')
          .send({ ...live, token: ARB.toLowerCase() }),
      ).expect(201);
      expect(arb.body).toMatchObject({
        token: 'ARB',
        tokenAddress: ARB,
        estimatedAmountOut: null,
      });
    });

    it('holds a sale to the minimum in USD where the token has a price', async () => {
      // 0.002 ETH at 2000 USD is 4 USD.
      const res = await asTenantLive(
        request(http())
          .post('/v1/offramp/p2p/sessions')
          .send({ ...live, token: NATIVE, amount: '0.002' }),
      ).expect(400);
      expect(res.body.message).toBe(
        'amount is below the minimum of 5 USD (about 0.002500 ETH)',
      );

      const sale = await asTenantLive(
        request(http())
          .post('/v1/offramp/p2p/sessions')
          .send({ ...live, token: NATIVE, amount: '0.01' }),
      ).expect(201);
      // 0.01 * 2000 * 1625.11
      expect(sale.body.estimatedAmountOut).toBe('32502.20');
    });
  });

  describe('selling', () => {
    const sale = { ...order, amount: '20' };

    it('reads the sell side of the sandbox market', async () => {
      const res = await asTenant(
        request(http()).get('/v1/offramp/p2p/market'),
      ).expect(200);

      expect(
        res.body.networks.map((n: { chainId: number }) => n.chainId),
      ).toEqual([421614]);
      expect(res.body.currencies).toEqual([
        expect.objectContaining({ id: 'ARS', price: '1000', minAmount: '5' }),
      ]);
    });

    it('needs the off-ramp scopes, and lets the public key sell but never list', async () => {
      const res = await asBuyerOnly(
        request(http()).post('/v1/offramp/p2p/sessions').send(sale),
      ).expect(403);
      expect(res.body.code).toBe('insufficient_scope');
      await asBuyerOnly(
        request(http()).get('/v1/offramp/p2p/tokens?chainId=421614'),
      ).expect(403);

      await asPublicKey(request(http()).get('/v1/offramp/p2p/market')).expect(
        200,
      );
      await asPublicKey(
        request(http()).get('/v1/offramp/p2p/tokens?chainId=421614'),
      ).expect(200);
      const opened = await asPublicKey(
        request(http()).post('/v1/offramp/p2p/sessions').send(sale),
      ).expect(201);
      expect(opened.body.publicToken).toEqual(expect.any(String));
      await asPublicKey(
        request(http()).post('/v1/offramp/p2p/quotes').send(sale),
      ).expect(503);
      const denied = await asPublicKey(
        request(http()).get('/v1/offramp/p2p/sessions'),
      ).expect(403);
      expect(denied.body.code).toBe('insufficient_scope');
      // A sale's token does not open it as a purchase, nor without the token.
      await asPublicKey(
        request(http()).get(`/v1/offramp/p2p/sessions/${opened.body.id}`),
      ).expect(404);
    });

    it('opens a sale as a SELL widget without fixing the wallet', async () => {
      prisma.p2pRampSession.create.mockClear();
      const res = await asTenant(
        request(http()).post('/v1/offramp/p2p/sessions').send(sale),
      ).expect(201);

      expect(res.body).toMatchObject({
        side: 'sell',
        amount: '20',
        token: 'USDT',
        estimatedAmountOut: '20000.00',
      });
      const url = new URL(res.body.widgetUrl);
      expect(url.searchParams.get('operation')).toBe('SELL');
      expect(url.searchParams.get('address')).toBeNull();
    });

    it('refuses a sale below the minimum in USD', async () => {
      const res = await asTenant(
        request(http())
          .post('/v1/offramp/p2p/sessions')
          .send({ ...sale, amount: '4' }),
      ).expect(400);

      expect(res.body.code).toBe('validation_failed');
      expect(res.body.message).toBe(
        'amount is below the minimum of 5 USD (about 5.00 USDT)',
      );
    });

    it('answers 503 for a firm quote while the integrator ids are not configured', async () => {
      const res = await asTenant(
        request(http()).post('/v1/offramp/p2p/quotes').send(sale),
      ).expect(503);

      expect(res.body.code).toBe('misconfigured');
      expect(requested.some((u) => u.includes('/quote/sell'))).toBe(false);
    });

    it('lists only sales, and answers 404 for one that is not the caller’s', async () => {
      prisma.p2pRampSession.findMany.mockClear();
      await asTenant(request(http()).get('/v1/offramp/p2p/sessions')).expect(
        200,
      );
      expect(prisma.p2pRampSession.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ side: 'sell', network: 'testnet' }),
      );

      const res = await asTenant(
        request(http()).get('/v1/offramp/p2p/sessions/clz_other'),
      ).expect(404);
      expect(res.body.message).toBe('P2P off-ramp session not found');
    });
  });
});
