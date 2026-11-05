import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

/** The marketplace's sandbox answers (trimmed copies of 2026-11-05's). */
const SANDBOX: Record<string, unknown> = {
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
  '/prices': {
    BUY: { ARS: { price: '990.86', limits: { in: { min: '4954.30' } } } },
  },
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

/** An ordinary dev key (the sandbox) with the on-ramp scopes. */
const asTenant = (r: request.Test) =>
  r
    .set('x-gateway-secret', SECRET)
    .set('x-consumer-username', 'cosmos_alice')
    .set('x-consumer-role', 'user')
    .set('x-consumer-env', 'dev')
    .set('x-consumer-permissions', 'onramp:read,onramp:write');

/** The shared public key, with every scope a P2P route asks for. */
const asPublicKey = (r: request.Test) =>
  r
    .set('x-gateway-secret', SECRET)
    .set('x-consumer-username', 'cosmos_public')
    .set('x-consumer-role', 'public')
    .set('x-consumer-env', 'dev')
    .set('x-consumer-permissions', 'onramp:read,onramp:write');

/**
 * The wiring in front of /v1/onramp/p2p, against the real client with the
 * marketplace's HTTP answered here and no integrator ids configured.
 */
describe('P2P on-ramp (e2e)', () => {
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
    onrampP2pSession: {
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
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith('https://api-testnet.eldorado.io/api/'))
          return realFetch(input, init);
        requested.push(url);
        const body = SANDBOX[new URL(url).pathname.replace(/^\/api/, '')];
        return new Response(JSON.stringify(body ?? {}), {
          status: body ? 200 : 404,
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
    token: 'USDT',
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

    expect(res.body.chainId).toBe(421614);
    expect(res.body.currencies.map((c: { id: string }) => c.id)).toEqual([
      'ARS',
    ]);
    expect(
      requested.every((u) => u.startsWith('https://api-testnet.eldorado.io/')),
    ).toBe(true);
  });

  it('lets the shared public key read the market, and nothing else', async () => {
    await asPublicKey(request(http()).get('/v1/onramp/p2p/market')).expect(200);

    // Built one at a time: a supertest request starts its server when made.
    const calls = [
      () => request(http()).post('/v1/onramp/p2p/sessions').send(order),
      () => request(http()).post('/v1/onramp/p2p/quotes').send(order),
      () => request(http()).get('/v1/onramp/p2p/sessions'),
      () => request(http()).get('/v1/onramp/p2p/sessions/clz_s1'),
    ];
    for (const call of calls) {
      const res = await asPublicKey(call()).expect(403);
      expect(res.body.code).toBe('insufficient_scope');
    }
  });

  it('opens a session with the recipient fixed in the widget URL', async () => {
    const res = await asTenant(
      request(http()).post('/v1/onramp/p2p/sessions').send(order),
    ).expect(201);

    expect(res.body).toMatchObject({
      network: 'testnet',
      chainId: 421614,
      address: ADDRESS,
      token: 'USDT',
    });
    const url = new URL(res.body.widgetUrl);
    expect(url.origin).toBe('https://widget-testnet.eldorado.io');
    expect(url.searchParams.get('address')).toBe(ADDRESS);
    expect(prisma.onrampP2pSession.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an order the market does not take, and a recipient that is not an EVM account', async () => {
    const below = await asTenant(
      request(http())
        .post('/v1/onramp/p2p/sessions')
        .send({ ...order, amount: '100' }),
    ).expect(400);
    expect(below.body.code).toBe('validation_failed');

    await asTenant(
      request(http())
        .post('/v1/onramp/p2p/sessions')
        .send({ ...order, address: 'GABC' }),
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
});
