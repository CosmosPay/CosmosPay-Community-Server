import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
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
const SANDBOX_API = 'https://api-testnet.eldorado.io/api';
const EMAIL = 'payer@example.com';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.e2e-payer-token.sig';
const ORDER_ID = '0b8f4c6e-2a71-4c1e-9d3b-5f7a8e9c1d20';

const sandboxKeys = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
})();

/** The sandbox market (as the payment requests suite has it) and its JWKS. */
const MARKET: Record<string, unknown> = {
  '/currencies': {
    currencies: [
      { id: 'ARS', type: 'FIAT', description: { en: 'Argentine Pesos' } },
    ],
  },
  '/payment-methods': {
    paymentMethods: [
      { id: 'bank_tx_ar', name: 'CVU/CBU o Alias (ARS)', currency: 'ARS' },
    ],
  },
  '/prices': {
    BUY: { ARS: { price: '1000', limits: { in: { min: '4954.30' } } } },
  },
  '/chains': { chains: ['421614'] },
  '/chains/421614/tokens': {
    tokens: [{ address: SANDBOX_USDT, symbol: 'USDT', decimals: 18 }],
  },
  '/.well-known/jwks.json': { keys: [sandboxKeys.jwk] },
};

type Row = Record<string, unknown>;

/** A table in memory with the filters the plugin writes: equality, `null`, `{ gt }` on a date. */
function table(prefix: string, defaults: Row) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([field, want]) =>
      want && typeof want === 'object' && 'gt' in want
        ? (row[field] as Date) > (want as { gt: Date }).gt
        : (row[field] ?? null) === want,
    );
  return {
    rows,
    create: jest.fn(({ data }: { data: Row }) => {
      const row = {
        id: `${prefix}${rows.length + 1}`,
        createdAt: new Date(Date.now() + rows.length),
        ...defaults,
        ...data,
      };
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    findMany: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
    ),
    count: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
    ),
    findFirst: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    findUnique: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => r.id === where.id);
      return Promise.resolve(row ? { ...row } : null);
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    }),
  };
}

const asSeller = (r: request.Test) =>
  r
    .set('x-gateway-secret', SECRET)
    .set('x-consumer-username', 'cosmos_seller')
    .set('x-consumer-role', 'user')
    .set('x-consumer-env', 'dev')
    .set('x-consumer-permissions', 'onramp:read,onramp:write');

/** The marketplace's order, at its current status, naming `reference`. */
function marketOrder(status: string, reference: string) {
  return {
    order: {
      userId: 'payer-user-id',
      apiOrderId: ORDER_ID,
      orderStatus: status,
      type: 'BUY',
      createdDate: '2026-11-13T12:30:00.000Z',
      dueDate: '2026-11-13T13:00:00.000Z',
      externalReferenceId: reference,
      cryptoDetails: {
        recipientAddress: ADDRESS.toLowerCase(),
        tokenAddress: SANDBOX_USDT.toLowerCase(),
        chainId: '421614',
      },
      quote: {
        in: { amount: '6000', currency: 'ARS' },
        out: { amount: '5.9' },
      },
      fiatDetails: {
        payerDetails: { fullName: 'Juan Pérez' },
        payeeDetails: {
          fullName: 'María Gómez',
          alias: 'maria.gomez.mp',
          bankId: 'mercado_pago',
        },
      },
    },
  };
}

/**
 * The wiring of the direct flow (`/v1/payment-links/fiat/{id}/direct/*`):
 * keyless, gated by the request's `p2pDirect` and the payer's sealed session,
 * against the real client with the sandbox marketplace's HTTP answered here.
 */
describe('P2P direct flow (e2e)', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  /** What the marketplace was asked, for the assertions. */
  const asked: { method: string; path: string; headers: Row; body: unknown }[] =
    [];
  let orderStatus = 'ACCEPTED';
  let orderReference = '';

  const requests = table('creq', {
    status: 'open',
    sharedPublicKey: false,
    paidAt: null,
    paidAmount: null,
    paidTxHash: null,
    paidSessionId: null,
    processingSessionId: null,
    cancelledAt: null,
  });
  const sessions = table('csess', {
    providerStatus: null,
    providerOrderId: null,
    completedAt: null,
    paymentRequestId: null,
  });
  const prisma = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    consumer: {
      upsert: jest.fn(({ where }: { where: { apisixUsername: string } }) =>
        Promise.resolve({ id: `c_${where.apisixUsername}` }),
      ),
    },
    paymentIntent: { findUnique: jest.fn().mockResolvedValue(null) },
    p2pPaymentRequest: requests,
    p2pRampSession: sessions,
    bankTransferAccount: { findUnique: jest.fn().mockResolvedValue(null) },
  };

  /** The sandbox's direct-flow API, by method and path. */
  const direct = (method: string, path: string): unknown => {
    const routes: Record<string, () => unknown> = {
      'POST /auth/login/send-otp': () => ({
        ok: true,
        otpIdentifier: 'otp-e2e',
        action: 'REGISTER',
      }),
      'POST /auth/login/verify-otp': () => ({
        ok: true,
        token: JWT,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: { email: EMAIL },
      }),
      'GET /kyc': () => ({
        kyc: { userId: 'u', kycLevel: 'L2', kycStatus: 'passed' },
      }),
      'GET /user-info': () => ({
        allowance: { month_allowance_usd: '10000', month_consumed_usd: '0' },
      }),
      'GET /payment-details': () => ({ paymentDetails: [] }),
      'POST /quote/buy': () => ({ quoteId: 'q-e2e' }),
      'POST /orders/buy': () => marketOrder('REQUESTED', orderReference),
      [`GET /orders/${ORDER_ID}`]: () =>
        marketOrder(orderStatus, orderReference),
      [`POST /orders/${ORDER_ID}`]: () => {
        orderStatus = 'FIAT_PAID';
        return marketOrder(orderStatus, orderReference);
      },
    };
    return routes[`${method} ${path}`]?.();
  };

  beforeAll(async () => {
    // This suite's deployment serves the direct flow: read when the app is built.
    process.env.ELDORADO_CLIENT_ID = 'client-e2e';
    process.env.ELDORADO_API_REFERRAL_ID = 'ref-api-e2e';
    process.env.P2P_DIRECT_SESSION_SECRET = Buffer.alloc(32, 9).toString(
      'base64',
    );
    const realFetch = global.fetch;
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(`${SANDBOX_API}/`)) return realFetch(input, init);
        const path = new URL(url).pathname.replace(/^\/api/, '');
        const method = init?.method ?? 'GET';
        asked.push({
          method,
          path,
          headers: (init?.headers ?? {}) as Row,
          body:
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as unknown)
              : undefined,
        });
        const body =
          method === 'GET' && path in MARKET
            ? MARKET[path]
            : direct(method, path);
        return new Response(
          JSON.stringify(body ?? { errorCode: 'NOT_FOUND', message: 'x' }),
          { status: body ? 200 : 404 },
        );
      });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
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
    fetchSpy.mockRestore();
    await app.close();
    process.env.ELDORADO_CLIENT_ID = '';
    process.env.ELDORADO_API_REFERRAL_ID = '';
    process.env.P2P_DIRECT_SESSION_SECRET = '';
  });

  const http = () => app.getHttpServer();
  let id: string;
  let session: string;
  const base = () => `/v1/payment-links/fiat/${id}/direct`;

  beforeAll(async () => {
    const created = await asSeller(
      request(http()).post('/v1/onramp/p2p/payment-requests').send({
        currency: 'ARS',
        amount: '6000',
        chainId: 421614,
        token: SANDBOX_USDT,
        address: ADDRESS,
      }),
    ).expect(201);
    id = created.body.id;
    orderReference = id;
    expect(created.body.p2pDirect).toBe(true);
  });

  it('offers the direct flow on the payer’s read of an ARS charge', async () => {
    const res = await request(http())
      .get(`/v1/payment-links/fiat/${id}`)
      .expect(200);
    expect(res.body).toMatchObject({ methods: ['p2p'], p2pDirect: true });
  });

  it('refuses an unknown charge, a bad email, and a charge this page cannot pay', async () => {
    await request(http())
      .post('/v1/payment-links/fiat/cmissing/direct/login')
      .send({ email: EMAIL })
      .expect(404);
    const bad = await request(http())
      .post(`${base()}/login`)
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_email');

    // A COP charge: the market does not take it, so neither does this page.
    requests.rows.push({
      ...requests.rows[0],
      id: 'ccopcharge0000000000000000',
      currency: 'COP',
    });
    const cop = await request(http())
      .post('/v1/payment-links/fiat/ccopcharge0000000000000000/direct/login')
      .send({ email: EMAIL })
      .expect(400);
    expect(cop.body.code).toBe('method_unavailable');
  });

  it('refuses every session route without a valid session', async () => {
    for (const header of [undefined, 'garbage']) {
      const req = request(http()).get(`${base()}/kyc`);
      const res = await (
        header ? req.set('X-Payer-Session', header) : req
      ).expect(401);
      expect(res.body.code).toBe('session_expired');
    }
    await request(http())
      .post(`${base()}/orders`)
      .send({ accountId: 'pd-1' })
      .expect(401);
    await request(http()).get(`${base()}/orders/${ORDER_ID}`).expect(401);
  });

  it('signs the payer in under the API referral id and seals the session', async () => {
    const login = await request(http())
      .post(`${base()}/login`)
      .set('Accept-Language', 'en-US,en;q=0.9')
      .send({ email: EMAIL })
      .expect(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(login.body).toEqual({ challenge: 'otp-e2e', newAccount: true });
    const sent = asked.find((a) => a.path === '/auth/login/send-otp')!;
    expect(sent.headers).toMatchObject({
      'X-Client-ID': 'client-e2e',
      'X-Referral-ID': 'ref-api-e2e',
    });
    expect(sent.body).toEqual({ email: EMAIL, language: 'en' });

    const verified = await request(http())
      .post(`${base()}/login/verify`)
      .send({ challenge: 'otp-e2e', code: 'A1B2C3D4' })
      .expect(200);
    expect(Object.keys(verified.body).sort()).toEqual(['expiresAt', 'session']);
    expect(JSON.stringify(verified.body)).not.toContain('e2e-payer-token');
    session = verified.body.session;

    const kyc = await request(http())
      .get(`${base()}/kyc`)
      .set('X-Payer-Session', session)
      .expect(200);
    expect(kyc.body).toEqual({
      step: 'ready',
      documentUrl: null,
      error: null,
      limitUsd: '10000.00',
    });
    expect(asked.find((a) => a.path === '/kyc')!.headers).toMatchObject({
      Authorization: `Bearer ${JWT}`,
    });

    // The same session on another charge is refused.
    await request(http())
      .get('/v1/payment-links/fiat/ccopcharge0000000000000000/direct/orders/x')
      .set('X-Payer-Session', session)
      .expect(401);
  });

  it('refuses a mistyped CVU/CBU with its own code, before anything is quoted', async () => {
    const quotes = asked.filter((a) => a.path === '/quote/buy').length;
    const res = await request(http())
      .post(`${base()}/orders`)
      .set('X-Payer-Session', session)
      .send({
        account: {
          holder: 'Juan Pérez',
          cbu: '0000003100000000001234',
          documentType: 'CUIL',
          document: '20123456786',
          bank: 'mercado_pago',
          accountType: 'savings',
        },
      })
      .expect(400);
    expect(res.body.code).toBe('invalid_cbu');
    expect(asked.filter((a) => a.path === '/quote/buy')).toHaveLength(quotes);
  });

  it('opens an order delivered to the seller, naming the charge, and records only its id', async () => {
    const res = await request(http())
      .post(`${base()}/orders`)
      .set('X-Payer-Session', session)
      .send({
        account: {
          holder: 'Juan Pérez',
          cbu: '0000-0031-0000-0000-0012-32',
          documentType: 'CUIL',
          document: '20-12345678-6',
          bank: 'mercado_pago',
          accountType: 'savings',
        },
      })
      .expect(201);
    expect(res.body).toMatchObject({
      id: ORDER_ID,
      status: 'matching',
      amount: '6000',
      currency: 'ARS',
      payTo: null,
    });
    const ordered = asked.find((a) => a.path === '/orders/buy')!;
    expect(ordered.body).toMatchObject({
      quoteId: 'q-e2e',
      externalReferenceId: id,
      cryptoDetails: {
        recipientAddress: ADDRESS,
        tokenAddress: SANDBOX_USDT,
        chainId: '421614',
      },
      fiatDetails: {
        details: {
          'CVU/CBU': '0000003100000000001232',
          documentNumber: '20123456786',
        },
      },
    });
    const recorded = sessions.rows.find((s) => s.providerOrderId === ORDER_ID)!;
    expect(recorded).toMatchObject({
      consumerId: 'c_cosmos_seller',
      paymentRequestId: id,
      side: 'buy',
    });
    const stored = JSON.stringify(recorded);
    for (const secret of [EMAIL, JWT, 'Juan', '20123456786', '001232']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('reads the order, marks it paid and holds the charge as processing until the marketplace cancels it', async () => {
    const read = await request(http())
      .get(`${base()}/orders/${ORDER_ID}`)
      .set('X-Payer-Session', session)
      .expect(200);
    expect(read.body).toMatchObject({
      status: 'pay',
      payTo: {
        holder: 'María Gómez',
        alias: 'maria.gomez.mp',
        cbu: null,
        bank: 'mercado_pago',
      },
    });

    const paid = await request(http())
      .post(`${base()}/orders/${ORDER_ID}/paid`)
      .set('X-Payer-Session', session)
      .expect(200);
    expect(paid.body.status).toBe('confirming');
    const processing = await request(http())
      .get(`/v1/payment-links/fiat/${id}`)
      .expect(200);
    expect(processing.body.status).toBe('processing');

    // Not cancellable once paid.
    const late = await request(http())
      .post(`${base()}/orders/${ORDER_ID}/cancel`)
      .set('X-Payer-Session', session)
      .expect(409);
    expect(late.body.code).toBe('order_not_cancellable');

    // The marketplace cancels it: the charge is open again.
    const raw = JSON.stringify({
      event: 'ORDER_STATUS_CHANGED',
      ...marketOrder('CANCELLED', id),
    });
    const hash = createHash('sha256').update(raw).digest('hex');
    await request(http())
      .post('/v1/onramp/p2p/webhooks')
      .set('content-type', 'application/json')
      .set('x-webhook-hash', hash)
      .set(
        'x-webhook-signature',
        createSign('RSA-SHA256')
          .update(hash)
          .sign(sandboxKeys.privateKey, 'base64'),
      )
      .send(raw)
      .expect(200, { received: true });
    const reopened = await request(http())
      .get(`/v1/payment-links/fiat/${id}`)
      .expect(200);
    expect(reopened.body.status).toBe('open');
  });

  it('answers an order of another charge as a missing one', async () => {
    orderReference = 'cotherchargeid000000000000';
    const res = await request(http())
      .get(`${base()}/orders/${ORDER_ID}`)
      .set('X-Payer-Session', session)
      .expect(404);
    expect(res.body.code).toBe('not_found');
    orderReference = id;
  });
});
