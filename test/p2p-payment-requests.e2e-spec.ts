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
const TX = `0x${'cd'.repeat(32)}`;

/** The marketplace's keys, made here: the webhook is verified against a stubbed JWKS. */
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
}
const sandboxKeys = keyPair();
const mainnetKeys = keyPair();
const strangerKeys = keyPair();

/** The sandbox market (trimmed copies of 2026-11-05's) and both JWKS. */
const SANDBOX: Record<string, unknown> = {
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
const MAINNET: Record<string, unknown> = {
  '/.well-known/jwks.json': { keys: [mainnetKeys.jwk] },
};

type Row = Record<string, unknown>;

/** A table in memory with the filters the plugin writes: equality, `null`, `{ gt }` on a date. */
function table(prefix: string, defaults: Row) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([field, want]) =>
      want && typeof want === 'object' && 'gt' in want
        ? (row[field] as Date) > (want as { gt: Date }).gt
        : row[field] === want,
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

const keyed =
  (username: string, role: string, permissions: string) => (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', username)
      .set('x-consumer-role', role)
      .set('x-consumer-env', 'dev')
      .set('x-consumer-permissions', permissions);

const SCOPES = 'onramp:read,onramp:write';
const asSeller = keyed('cosmos_seller', 'user', SCOPES);
const asOtherTenant = keyed('cosmos_mallory', 'user', SCOPES);
const asReader = keyed('cosmos_seller', 'user', 'onramp:read');
const asPublicKey = keyed('cosmos_public', 'public', SCOPES);

/** A webhook delivery signed like the marketplace signs it. */
function signedWebhook(body: unknown, signer = sandboxKeys) {
  const raw = JSON.stringify(body);
  const hash = createHash('sha256').update(raw).digest('hex');
  return {
    raw,
    hash,
    signature: createSign('RSA-SHA256')
      .update(hash)
      .sign(signer.privateKey, 'base64'),
  };
}

/**
 * The wiring of payment requests: the seller's keyed routes, the payer's
 * keyless ones under /v1/payment-links/fiat, and the marketplace's webhook,
 * against the real client with the marketplace's HTTP (market and JWKS)
 * answered here.
 */
describe('P2P payment requests (e2e)', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  const requests = table('creq', {
    status: 'open',
    sharedPublicKey: false,
    paidAt: null,
    paidAmount: null,
    paidTxHash: null,
    paidSessionId: null,
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
    // The bank transfer rail (plugin `koywe`) asks for the seller's account: none here.
    bankTransferAccount: { findUnique: jest.fn().mockResolvedValue(null) },
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
        const body = host[1][new URL(url).pathname.replace(/^\/api/, '')];
        return new Response(JSON.stringify(body ?? { message: 'error' }), {
          status: body ? 200 : 500,
        });
      });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    // As main.ts: the webhook verifies the exact bytes received.
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
  });

  const http = () => app.getHttpServer();
  const charge = {
    currency: 'ARS',
    amount: '6000',
    chainId: 421614,
    token: SANDBOX_USDT,
    address: ADDRESS.toLowerCase(),
    description: '  Table 4  ',
  };

  describe('the seller’s routes', () => {
    it('refuse a caller that did not come through the gateway, and a key without the scope', async () => {
      const res = await request(http())
        .post('/v1/onramp/p2p/payment-requests')
        .send(charge)
        .expect(403);
      expect(res.body.code).toBe('gateway_required');

      const denied = await asReader(
        request(http()).post('/v1/onramp/p2p/payment-requests').send(charge),
      ).expect(403);
      expect(denied.body.code).toBe('insufficient_scope');
    });

    it('create a charge with its page and QR, the description trimmed and the address checksummed', async () => {
      const res = await asSeller(
        request(http()).post('/v1/onramp/p2p/payment-requests').send(charge),
      ).expect(201);

      expect(res.body).toMatchObject({
        network: 'testnet',
        status: 'open',
        currency: 'ARS',
        amount: '6000',
        chainId: 421614,
        token: 'USDT',
        tokenAddress: SANDBOX_USDT,
        tokenDecimals: 18,
        address: ADDRESS,
        description: 'Table 4',
        // 6000 / 1000 / 1
        estimatedAmountOut: '6.00',
        url: `https://payments.cosmospay.lat/fiat/${res.body.id}`,
        paidAt: null,
      });
      expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
      expect(res.body).not.toHaveProperty('publicToken');
    });

    it('refuse a description on two lines, a lifetime out of range and terms the market does not take', async () => {
      for (const bad of [
        { description: 'Table 4\nand a second line' },
        { description: '   ' },
        { description: 'x'.repeat(141) },
        { expiresInMinutes: 4 },
        { expiresInMinutes: 43201 },
        { address: 'GABC' },
      ]) {
        await asSeller(
          request(http())
            .post('/v1/onramp/p2p/payment-requests')
            .send({ ...charge, ...bad }),
        ).expect(400);
      }
      const below = await asSeller(
        request(http())
          .post('/v1/onramp/p2p/payment-requests')
          .send({ ...charge, amount: '100' }),
      ).expect(400);
      expect(below.body.message).toBe(
        'amount is below the minimum of 4954.30 ARS',
      );
    });

    it('read and cancel only the seller’s own charges', async () => {
      const created = await asSeller(
        request(http()).post('/v1/onramp/p2p/payment-requests').send(charge),
      ).expect(201);
      const path = `/v1/onramp/p2p/payment-requests/${created.body.id}`;

      await asOtherTenant(request(http()).get(path)).expect(404);
      await asOtherTenant(request(http()).post(`${path}/cancel`)).expect(404);
      await asSeller(request(http()).get(path)).expect(200);

      const listed = await asSeller(
        request(http()).get('/v1/onramp/p2p/payment-requests'),
      ).expect(200);
      expect(listed.body.total).toBeGreaterThanOrEqual(1);

      const cancelled = await asSeller(
        request(http()).post(`${path}/cancel`),
      ).expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      const again = await asSeller(
        request(http()).post(`${path}/cancel`),
      ).expect(409);
      expect(again.body.code).toBe('request_closed');
    });

    it('let the shared public key create and read back with its token, never list', async () => {
      const created = await asPublicKey(
        request(http()).post('/v1/onramp/p2p/payment-requests').send(charge),
      ).expect(201);
      expect(created.body.publicToken).toEqual(expect.any(String));
      const path = `/v1/onramp/p2p/payment-requests/${created.body.id}`;

      await asPublicKey(request(http()).get(path)).expect(404);
      await asPublicKey(
        request(http()).get(path).set('x-record-token', 'not-the-token'),
      ).expect(404);
      await asPublicKey(
        request(http())
          .get(path)
          .set('x-record-token', created.body.publicToken),
      ).expect(200);
      const listed = await asPublicKey(
        request(http()).get('/v1/onramp/p2p/payment-requests'),
      ).expect(403);
      expect(listed.body.code).toBe('insufficient_scope');
    });
  });

  describe('the payer’s routes and the webhook', () => {
    let id: string;

    beforeAll(async () => {
      const created = await asSeller(
        request(http()).post('/v1/onramp/p2p/payment-requests').send(charge),
      ).expect(201);
      id = created.body.id;
    });

    it('read a charge with no API key, never naming who is paid', async () => {
      const res = await request(http())
        .get(`/v1/payment-links/fiat/${id}`)
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        id,
        network: 'testnet',
        status: 'open',
        currency: 'ARS',
        amount: '6000',
        description: 'Table 4',
        chainId: 421614,
        token: 'USDT',
        tokenAddress: SANDBOX_USDT,
        estimatedAmountOut: '6.00',
        paymentMethods: [{ id: 'bank_tx_ar', name: 'CVU/CBU o Alias (ARS)' }],
        // No bank transfer: the seller has no bank transfer account.
        methods: ['p2p'],
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
        paidAt: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(ADDRESS);
    });

    it('answer 404 for an unknown charge, and leave the payment links’ own routes alone', async () => {
      await request(http()).get('/v1/payment-links/fiat/cmissing').expect(404);
      const link = await request(http())
        .get('/v1/payment-links/cmissing')
        .expect(404);
      expect(link.body.message).toBe('Payment intent cmissing not found');
    });

    it('start paying with no API key: a purchase owned by the seller, delivered to the seller', async () => {
      const res = await request(http())
        .post(`/v1/payment-links/fiat/${id}/sessions`)
        .send({ paymentMethod: 'bank_tx_ar' })
        .expect(201);

      expect(Object.keys(res.body).sort()).toEqual(['reference', 'widgetUrl']);
      const url = new URL(res.body.widgetUrl);
      expect(url.searchParams.get('address')).toBe(ADDRESS);
      expect(url.searchParams.get('amount')).toBe('6000');
      const opened = sessions.rows.find(
        (s) => s.reference === res.body.reference,
      );
      expect(opened).toMatchObject({
        consumerId: 'c_cosmos_seller',
        paymentRequestId: id,
        side: 'buy',
      });

      const bad = await request(http())
        .post(`/v1/payment-links/fiat/${id}/sessions`)
        .send({ paymentMethod: 'pix' })
        .expect(400);
      expect(bad.body.code).toBe('validation_failed');
    });

    it('refuse a delivery that is not signed by the marketplace', async () => {
      const opened = sessions.rows.find((s) => s.paymentRequestId === id)!;
      const body = {
        event: 'ORDER_STATUS_CHANGED',
        order: {
          orderStatus: 'COMPLETED',
          type: 'BUY',
          externalReferenceId: opened.reference,
        },
      };
      const forged = signedWebhook(body, strangerKeys);

      const res = await request(http())
        .post('/v1/onramp/p2p/webhooks')
        .set('content-type', 'application/json')
        .set('x-webhook-hash', forged.hash)
        .set('x-webhook-signature', forged.signature)
        .send(forged.raw)
        .expect(401);
      expect(res.body.code).toBe('webhook_signature_invalid');
      await request(http())
        .post('/v1/onramp/p2p/webhooks')
        .set('content-type', 'application/json')
        .send(forged.raw)
        .expect(401);
      expect(opened.providerStatus).toBeNull();
    });

    it('marks the charge paid on the marketplace’s signed completion, and closes it to new payments', async () => {
      const opened = sessions.rows.find((s) => s.paymentRequestId === id)!;
      const delivery = signedWebhook({
        event: 'ORDER_STATUS_CHANGED',
        order: {
          apiOrderId: 'ord-1',
          orderStatus: 'COMPLETED',
          type: 'BUY',
          externalReferenceId: opened.reference,
          cryptoDetails: {
            recipientAddress: ADDRESS.toLowerCase(),
            tokenAddress: SANDBOX_USDT.toLowerCase(),
            chainId: '421614',
          },
          quote: {
            in: { amount: '6000', currency: 'ARS' },
            out: { amount: '5.9' },
          },
          transferInfo: { amountOut: '5.90', txHashDestination: TX },
        },
      });

      await request(http())
        .post('/v1/onramp/p2p/webhooks')
        .set('content-type', 'application/json')
        .set('x-webhook-hash', delivery.hash)
        .set('x-webhook-signature', delivery.signature)
        .send(delivery.raw)
        .expect(200, { received: true });

      const read = await request(http())
        .get(`/v1/payment-links/fiat/${id}`)
        .expect(200);
      expect(read.body.status).toBe('paid');
      expect(read.body.paidAt).toEqual(expect.any(String));
      expect(JSON.stringify(read.body)).not.toContain(TX);

      const closed = await request(http())
        .post(`/v1/payment-links/fiat/${id}/sessions`)
        .send({ paymentMethod: 'bank_tx_ar' })
        .expect(409);
      expect(closed.body.code).toBe('request_closed');

      // The seller reads the payment, and the purchase that made it.
      const mine = await asSeller(
        request(http()).get(`/v1/onramp/p2p/payment-requests/${id}`),
      ).expect(200);
      expect(mine.body).toMatchObject({
        status: 'paid',
        paidAmount: '5.90',
        paidTxHash: TX,
      });
      const listed = await asSeller(
        request(http()).get('/v1/onramp/p2p/sessions'),
      ).expect(200);
      expect(
        listed.body.data.find(
          (s: { reference: string }) => s.reference === opened.reference,
        ),
      ).toMatchObject({ status: 'COMPLETED', paymentRequestId: id });
    });
  });
});
