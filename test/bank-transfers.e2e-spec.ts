import { createHmac } from 'node:crypto';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { BankTransferWebhooks } from '@/native-plugins/koywe/bank-transfer-webhooks.service';
import {
  koyweDb,
  memoryTable,
} from '@/native-plugins/koywe/koywe-memory-db.fake-spec';
import { PrismaService } from '@/prisma/prisma.service';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const WEBHOOK_SECRET = 'e2e-sandbox-webhook-secret-e2e-sandbox-webhook-secret';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const SANDBOX_USDT = '0x25f5D414F85b7f4668ADe4E557ef234023208771';
const TX = `0x${'ef'.repeat(32)}`;
const CVU = '0000003100000000000077';

/** The P2P sandbox market (as the payment requests suite has it). */
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
};

/** The bank transfer provider's sandbox, answered here: method and path to answer. */
const PROVIDER: [string, RegExp, unknown][] = [
  ['POST', /\/auth\/sign-in$/, { token: 'e2e-token' }],
  ['GET', /\/countries$/, [{ id: 'ctry_ar', twoLetterIso: 'AR' }]],
  ['POST', /\/organizations\/org_e2e\/merchants$/, { merchantId: 'mrc_e2e' }],
  [
    'POST',
    /\/merchants\/mrc_e2e\/onboarding\/kyb$/,
    {
      id: 'kyb_e2e',
      status: 'CREATED',
      formLink: 'https://verify.example/f/1',
    },
  ],
  ['GET', /\/merchants\/mrc_e2e\/virtual-accounts$/, []],
  [
    'POST',
    /\/merchants\/mrc_e2e\/virtual-accounts$/,
    {
      id: 'va_e2e',
      currency: 'ARS',
      isActive: true,
      virtualBankAccountNumber: CVU,
      alias: 'seller.e2e.cp',
    },
  ],
  ['GET', /\/merchants\/mrc_e2e\/accounts\/search/, []],
  ['POST', /\/merchants\/mrc_e2e\/accounts$/, { id: 'acc_e2e' }],
  [
    'POST',
    /\/merchants\/mrc_e2e\/quotes$/,
    { id: 'q_e2e', finalAmountOut: 5.9 },
  ],
  [
    'POST',
    /\/merchants\/mrc_e2e\/orders$/,
    { id: 'ord_e2e', status: 'PROCESSING', policyResult: 'ALLOW' },
  ],
  [
    'GET',
    /\/merchants\/mrc_e2e\/orders\/ord_e2e$/,
    { id: 'ord_e2e', status: 'COMPLETED', amountOut: 5.9, transactionHash: TX },
  ],
];

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
const asReader = keyed('cosmos_seller', 'user', 'onramp:read');
const asPublicKey = keyed('cosmos_public', 'public', SCOPES);

/** A provider delivery, signed with the sandbox's webhook secret (or another). */
function delivery(type: string, data: unknown, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify({
    id: `evt_${type}_${Math.random().toString(36).slice(2)}`,
    type,
    version: 'v1',
    environment: 'sandbox',
    organization_id: 'org_e2e',
    merchant_id: 'mrc_e2e',
    data,
  });
  return {
    raw,
    signature: createHmac('sha256', secret).update(raw).digest('hex'),
  };
}

/**
 * The wiring of bank transfers (plugin `koywe`): the seller's account routes,
 * the payer's keyless instructions under /v1/payment-links/fiat, and the
 * provider's signed webhook, end to end against the sandbox environment the
 * suite pins, with the provider's HTTP answered here.
 */
describe('Bank transfers (e2e)', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  const db = koyweDb();
  const prisma = {
    ...db,
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
    p2pPaymentRequest: memoryTable('creq', {
      status: 'open',
      sharedPublicKey: false,
      paidAt: null,
      paidAmount: null,
      paidTxHash: null,
      paidMethod: null,
      paidSessionId: null,
      cancelledAt: null,
    }),
    p2pRampSession: memoryTable('csess'),
  };

  beforeAll(async () => {
    const realFetch = global.fetch;
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? 'GET';
        if (url.startsWith('https://api-testnet.eldorado.io/api/')) {
          const body = MARKET[new URL(url).pathname.replace(/^\/api/, '')];
          return new Response(JSON.stringify(body ?? { message: 'error' }), {
            status: body ? 200 : 500,
          });
        }
        if (url.startsWith('https://api-sandbox.koywe.example/')) {
          const answer = PROVIDER.find(
            ([verb, path]) =>
              verb === method && path.test(new URL(url).pathname),
          );
          return new Response(
            JSON.stringify(answer?.[2] ?? { message: 'no' }),
            {
              status: answer ? 200 : 404,
            },
          );
        }
        return realFetch(input, init);
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
  });

  const http = () => app.getHttpServer();
  const settled = () => app.get(BankTransferWebhooks).settled();
  const PERSON = {
    type: 'person',
    name: 'Juan Pérez',
    taxId: '20-12345678-6',
    email: 'juan@example.com',
    address: 'Av. Belgrano 123',
    city: 'Salta',
    postalCode: '4400',
    dateOfBirth: '1990-01-15',
  };

  describe('the seller’s account', () => {
    it('refuses a caller without the gateway, a key without the scope, and the shared public key', async () => {
      await request(http()).get('/v1/onramp/transfer/account').expect(403);
      const scope = await asReader(
        request(http()).post('/v1/onramp/transfer/account').send(PERSON),
      ).expect(403);
      expect(scope.body.code).toBe('insufficient_scope');
      for (const call of [
        () => request(http()).get('/v1/onramp/transfer/account'),
        () => request(http()).post('/v1/onramp/transfer/account').send(PERSON),
      ]) {
        const res = await asPublicKey(call()).expect(403);
        expect(res.body.code).toBe('account_required');
      }
    });

    it('reads none, refuses a bad tax id or a person with no birth date, then opens one and refuses a second', async () => {
      const none = await asSeller(
        request(http()).get('/v1/onramp/transfer/account'),
      ).expect(200);
      expect(none.body).toMatchObject({ status: 'none', cvu: null });

      const badTaxId = await asSeller(
        request(http())
          .post('/v1/onramp/transfer/account')
          .send({ ...PERSON, taxId: '20-12345678-5' }),
      ).expect(400);
      expect(badTaxId.body.code).toBe('invalid_tax_id');
      await asSeller(
        request(http())
          .post('/v1/onramp/transfer/account')
          .send({ ...PERSON, dateOfBirth: undefined }),
      ).expect(400);

      const opened = await asSeller(
        request(http()).post('/v1/onramp/transfer/account').send(PERSON),
      ).expect(201);
      expect(opened.body).toEqual({
        status: 'pending',
        type: 'person',
        name: 'Juan Pérez',
        verificationUrl: 'https://verify.example/f/1',
        reason: null,
        alias: null,
        cvu: null,
        bank: null,
        updatedAt: expect.any(String),
      });
      expect(JSON.stringify(db.bankTransferAccount.rows)).not.toContain(
        '12345678',
      );

      const again = await asSeller(
        request(http()).post('/v1/onramp/transfer/account').send(PERSON),
      ).expect(409);
      expect(again.body.code).toBe('account_exists');
    });

    it('is approved by the provider’s signed KYB webhook, and gets its CVU', async () => {
      const approved = delivery('merchant.kyb.approved', { kybId: 'kyb_e2e' });

      await request(http())
        .post('/v1/onramp/transfer/webhooks')
        .set('content-type', 'application/json')
        .set('koywe-signature', approved.signature)
        .send(approved.raw)
        .expect(200, { received: true });
      await settled();

      const read = await asSeller(
        request(http()).get('/v1/onramp/transfer/account'),
      ).expect(200);
      expect(read.body).toMatchObject({
        status: 'approved',
        alias: 'seller.e2e.cp',
        cvu: CVU,
        verificationUrl: null,
      });
    });
  });

  describe('a charge paid by bank transfer', () => {
    let id: string;

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
      expect(created.body.methods).toEqual(['transfer', 'p2p']);
    });

    it('offers the bank transfer first to the payer', async () => {
      const read = await request(http())
        .get(`/v1/payment-links/fiat/${id}`)
        .expect(200);
      expect(read.body).toMatchObject({
        status: 'open',
        methods: ['transfer', 'p2p'],
      });
    });

    it('answers the instructions with no API key: 201, then 200 for the same document', async () => {
      const path = `/v1/payment-links/fiat/${id}/transfers`;
      const first = await request(http())
        .post(path)
        .send({ document: '20-12345678-6' })
        .expect(201);

      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.body).toEqual({
        id: expect.any(String),
        status: 'awaiting_deposit',
        currency: 'ARS',
        amount: '6000',
        alias: 'seller.e2e.cp',
        cvu: CVU,
        holder: 'Juan Pérez',
        bank: null,
        documentHint: '…786',
        expiresAt: expect.any(String),
      });
      const again = await request(http())
        .post(path)
        .send({ document: '12.345.678' })
        .expect(200);
      expect(again.body.id).toBe(first.body.id);
    });

    it('refuses a bad document, an unknown charge and an unexpected field', async () => {
      const bad = await request(http())
        .post(`/v1/payment-links/fiat/${id}/transfers`)
        .send({ document: '20-12345678-5' })
        .expect(400);
      expect(bad.body.code).toBe('invalid_document');
      await request(http())
        .post('/v1/payment-links/fiat/cmissing/transfers')
        .send({ document: '12345678' })
        .expect(404);
      await request(http())
        .post(`/v1/payment-links/fiat/${id}/transfers`)
        .send({ document: '12345678', extra: true })
        .expect(400);
    });

    it('refuses a delivery the webhook secret did not sign', async () => {
      const forged = delivery(
        'bank_income.received',
        { amount: 6000, currency: 'ARS', documentNumber: '20123456786' },
        'a-stranger-secret-a-stranger-secret-a-stranger',
      );

      const res = await request(http())
        .post('/v1/onramp/transfer/webhooks')
        .set('content-type', 'application/json')
        .set('koywe-signature', forged.signature)
        .send(forged.raw)
        .expect(401);
      expect(res.body.code).toBe('webhook_signature_invalid');
      await request(http())
        .post('/v1/onramp/transfer/webhooks')
        .set('content-type', 'application/json')
        .send(forged.raw)
        .expect(401);
      expect(db.bankIncomeEvent.rows).toHaveLength(0);
    });

    it('turns processing on the signed deposit, converts it, and is paid by transfer on the completed order', async () => {
      const deposit = delivery('bank_income.received', {
        amount: 6000,
        currency: 'ARS',
        documentNumber: '20123456786',
        referenceId: 'bm_e2e',
      });
      await request(http())
        .post('/v1/onramp/transfer/webhooks')
        .set('content-type', 'application/json')
        .set('koywe-signature', deposit.signature)
        .send(deposit.raw)
        .expect(200, { received: true });

      const processing = await request(http())
        .get(`/v1/payment-links/fiat/${id}`)
        .expect(200);
      expect(processing.body.status).toBe('processing');
      await settled();
      expect(db.bankTransfer.rows[0]).toMatchObject({
        status: 'converting',
        providerOrderId: 'ord_e2e',
        depositAmount: '6000',
      });
      const closed = await request(http())
        .post(`/v1/payment-links/fiat/${id}/transfers`)
        .send({ document: '87654321' })
        .expect(409);
      expect(closed.body.code).toBe('request_closed');

      const completed = delivery('order.completed', {
        orderId: 'ord_e2e',
        type: 'ONRAMP',
        status: 'COMPLETED',
        externalId: db.bankTransfer.rows[0].id,
      });
      await request(http())
        .post('/v1/onramp/transfer/webhooks')
        .set('content-type', 'application/json')
        .set('koywe-signature', completed.signature)
        .send(completed.raw)
        .expect(200);
      await settled();

      const mine = await asSeller(
        request(http()).get(`/v1/onramp/p2p/payment-requests/${id}`),
      ).expect(200);
      expect(mine.body).toMatchObject({
        status: 'paid',
        paidMethod: 'transfer',
        paidAmount: '5.9',
        paidTxHash: TX,
      });
    });
  });
});
