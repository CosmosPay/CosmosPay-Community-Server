import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import {
  PAYMENT_DEPOSIT_ASSETS_RATE_LIMIT,
  PAYMENT_LINK_READ_RATE_LIMIT,
  PAYMENT_LINK_TRANSACTION_RATE_LIMIT,
} from '@/payment-intents/payment-intents.constants';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * `GET /v1/payment-links/{id}` — the hosted checkout's anonymous read.
 *
 * What this suite pins is the wiring a unit test cannot see: that the route is
 * reachable with NO credential at all (the checkout page holds no API key and
 * no gateway secret), that a consumer the client names is dropped rather than
 * used — for the rate-limit bucket in particular — that the body is the payer's
 * view and nothing else, that it is never cached, and that the budget refuses.
 */
describe('Payment links (e2e)', () => {
  let app: INestApplication;

  const MERCHANT = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
  const EVM_MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';

  /** Full rows, the way Prisma stores them — what the select must cut down. */
  const rows = new Map<string, Record<string, unknown>>([
    [
      'cmh4x2k9a0001l70g8v5q3z2w',
      {
        id: 'cmh4x2k9a0001l70g8v5q3z2w',
        consumerId: 'consumer_secret_id',
        kind: 'TX',
        chain: 'stellar',
        network: 'testnet',
        status: 'PENDING',
        source: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
        destination: MERCHANT,
        chainReference: null,
        amount: '25.5',
        asset: 'native',
        assetIssuer: null,
        memo: '4127759120438726917',
        msg: 'Order #24',
        callback: 'url:https://merchant.example/hooks/sep7',
        xdr: 'AAAAAgAAAAB-envelope',
        uri: `web+stellar:pay?destination=${MERCHANT}&amount=25.5&memo=4127759120438726917&memo_type=MEMO_ID&msg=Order+%2324`,
        txHash: null,
        reference: 'merchant-order-24',
        // Created without a design: the page is told `classic`.
        checkoutTheme: null,
        networkFee: null,
        expiresAt: new Date('2026-10-24T13:34:56.000Z'),
        createdAt: new Date('2026-10-24T12:34:56.000Z'),
        updatedAt: new Date('2026-10-24T12:34:56.000Z'),
      },
    ],
    [
      'cmh4x2k9a0002l70gmonaddep',
      {
        id: 'cmh4x2k9a0002l70gmonaddep',
        consumerId: 'consumer_secret_id',
        kind: 'PAY',
        chain: 'monad',
        network: 'public',
        status: 'SUCCEEDED',
        source: null,
        destination: EVM_MERCHANT,
        chainReference: DEPOSIT,
        amount: '1',
        asset: 'native',
        assetIssuer: null,
        memo: '42',
        msg: null,
        callback: null,
        xdr: null,
        uri: `ethereum:${DEPOSIT}@143?value=1000000000000000000`,
        txHash: `0x${'ab'.repeat(32)}`,
        reference: null,
        checkoutTheme: 'ticket',
        networkFee: '0.02',
        expiresAt: null,
        createdAt: new Date('2026-10-24T12:34:56.000Z'),
        updatedAt: new Date('2026-10-24T12:35:56.000Z'),
      },
    ],
    [
      'cmh4x2k9a0003l70gbaseusdc0',
      {
        id: 'cmh4x2k9a0003l70gbaseusdc0',
        consumerId: 'consumer_secret_id',
        kind: 'PAY',
        chain: 'base',
        network: 'public',
        status: 'PENDING',
        source: null,
        destination: EVM_MERCHANT,
        chainReference: null,
        amount: '25',
        asset: 'USDC',
        assetIssuer: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        assetDecimals: 6,
        memo: '43',
        msg: null,
        callback: null,
        xdr: null,
        uri: 'https://payments.cosmospay.lat/cmh4x2k9a0003l70gbaseusdc0',
        txHash: null,
        reference: null,
        checkoutTheme: null,
        networkFee: null,
        merchantFee: null,
        crossChainFeeBps: 50,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date('2026-10-24T12:34:56.000Z'),
        updatedAt: new Date('2026-10-24T12:34:56.000Z'),
      },
    ],
  ]);

  const rateLimitCounters = new Map<string, number>();

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    consumer: { upsert: jest.fn() },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    paymentDeposit: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    /** The rate limiter's counter, keyed by bucket (window arithmetic is the service spec's). */
    $queryRaw: jest.fn((_sql: unknown, key: string) => {
      const next = (rateLimitCounters.get(key) ?? 0) + 1;
      rateLimitCounters.set(key, next);
      return Promise.resolve([{ count: next }]);
    }),
    paymentIntent: {
      // Honours `select` the way Prisma does, so a column the select leaves out
      // is really absent from what the service gets back.
      findUnique: jest.fn(({ where, select }: any) => {
        const row = rows.get(where.id);
        if (!row) return Promise.resolve(null);
        const picked = Object.fromEntries(
          Object.keys(select as object).map((k) => [k, row[k]]),
        );
        return Promise.resolve(picked);
      }),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rateLimitCounters.clear();
    prismaMock.$queryRaw.mockClear();
    prismaMock.consumer.upsert.mockClear();
    prismaMock.paymentIntent.findUnique.mockClear();
  });

  const http = () => app.getHttpServer();

  it('serves the payer’s view to a caller with no gateway secret and no key', async () => {
    const res = await request(http())
      .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w')
      .expect(200);

    expect(res.body).toEqual({
      id: 'cmh4x2k9a0001l70g8v5q3z2w',
      kind: 'TX',
      chain: 'stellar',
      network: 'testnet',
      status: 'PENDING',
      payTo: MERCHANT,
      amount: '25.5',
      asset: 'native',
      assetIssuer: null,
      memo: '4127759120438726917',
      msg: 'Order #24',
      uri: rows.get('cmh4x2k9a0001l70g8v5q3z2w')!.uri,
      qr: expect.stringMatching(/^data:image\/png;base64,/),
      txHash: null,
      networkFee: null,
      merchantFee: null,
      payerAccountRequired: false,
      crossChainPayment: false,
      expiresAt: '2026-10-24T13:34:56.000Z',
      createdAt: '2026-10-24T12:34:56.000Z',
      checkoutTheme: 'classic',
    });
    for (const field of [
      'consumerId',
      'source',
      'xdr',
      'reference',
      'callback',
      'destination',
      'updatedAt',
    ]) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  it('sends a Monad payer to the deposit address, never the merchant', async () => {
    const res = await request(http())
      .get('/v1/payment-links/cmh4x2k9a0002l70gmonaddep')
      .expect(200);

    expect(res.body).toMatchObject({
      chain: 'monad',
      status: 'SUCCEEDED',
      payTo: DEPOSIT,
      networkFee: '0.02',
      expiresAt: null,
      checkoutTheme: 'ticket',
    });
    expect(JSON.stringify(res.body)).not.toContain(EVM_MERCHANT);
  });

  it('has no address to pay on a network paid through deposit addresses', async () => {
    const res = await request(http())
      .get('/v1/payment-links/cmh4x2k9a0003l70gbaseusdc0')
      .expect(200);

    expect(res.body).toMatchObject({
      chain: 'base',
      payTo: null,
      crossChainPayment: true,
      asset: 'USDC',
      uri: 'https://payments.cosmospay.lat/cmh4x2k9a0003l70gbaseusdc0',
    });
    expect(JSON.stringify(res.body)).not.toContain(EVM_MERCHANT);
    expect(res.body).not.toHaveProperty('crossChainFeeBps');
  });

  it('is never cached, and reports its budget', async () => {
    const res = await request(http())
      .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w')
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['ratelimit-limit']).toBe(
      String(PAYMENT_LINK_READ_RATE_LIMIT.limit),
    );
    expect(res.headers['ratelimit-remaining']).toBe(
      String(PAYMENT_LINK_READ_RATE_LIMIT.limit - 1),
    );
  });

  it('ignores a consumer the client names — for the budget too', async () => {
    await request(http())
      .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w')
      .set('x-consumer-username', 'cosmos_u1')
      .expect(200);
    await request(http())
      .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w')
      .set('x-consumer-username', 'a-fresh-name-for-a-fresh-budget')
      .expect(200);

    expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();
    // Both requests counted against ONE anonymous, per-address bucket: a
    // client-chosen name is not a way to a new budget.
    const keys = prismaMock.$queryRaw.mock.calls.map(
      ([, key]: [unknown, string]) => key,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^payment-links:read:anonymous:/);
  });

  it('answers an unknown id with the not-found envelope', async () => {
    const res = await request(http())
      .get('/v1/payment-links/cmh4x2k9a0009l70gneverwas')
      .expect(404);

    expect(res.body).toEqual({
      statusCode: 404,
      code: 'not_found',
      error: 'Not Found',
      message: 'Payment intent cmh4x2k9a0009l70gneverwas not found',
      path: '/v1/payment-links/cmh4x2k9a0009l70gneverwas',
      timestamp: expect.any(String),
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses past the budget with 429 rate_limited and Retry-After', async () => {
    const { limit } = PAYMENT_LINK_READ_RATE_LIMIT;
    await request(http())
      .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w')
      .expect(200);
    // Spend the rest of this address's bucket without sixty QR renders: the
    // counter arithmetic is rate-limit.service.spec's, the refusal is ours.
    const [[, key]] = prismaMock.$queryRaw.mock.calls as [unknown, string][];
    rateLimitCounters.set(key, limit);

    const res = await request(http())
      .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w')
      .expect(429);

    expect(res.body).toEqual({
      statusCode: 429,
      code: 'rate_limited',
      error: 'Too Many Requests',
      message: expect.stringMatching(/^Too many requests\. Retry in \d+s\.$/),
      path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w',
      timestamp: expect.any(String),
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(0);
    expect(res.headers['ratelimit-limit']).toBe(String(limit));
    expect(res.headers['ratelimit-remaining']).toBe('0');
    // Refused before the handler ran: nothing was read.
    expect(prismaMock.paymentIntent.findUnique).toHaveBeenCalledTimes(1);
  });
  describe('the Solana Pay transaction request (/v1/payment-links/{id}/solana-pay)', () => {
    it('is reachable with no key and refuses a link that is not one', async () => {
      const read = await request(http())
        .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay')
        .expect(400);
      expect(read.body.message).toBe(
        'This payment link is not a Solana Pay transaction request: open its uri',
      );
      expect(read.headers['cache-control']).toBe('no-store');
      expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();

      const unknown = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0009l70gneverwas/solana-pay')
        .send({ account: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' })
        .expect(404);
      expect(unknown.body.code).toBe('not_found');
      const keys = prismaMock.$queryRaw.mock.calls.map(
        ([, key]: [unknown, string]) => key,
      );
      expect(
        keys.some((key: string) => /^payment-links:read:anonymous:/.test(key)),
      ).toBe(true);
      expect(
        keys.some((key: string) =>
          /^payment-links:transaction:anonymous:/.test(key),
        ),
      ).toBe(true);
    });

    it('refuses an account that is not a Solana address before reading the link', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay')
        .send({ account: 'not-an-account' })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(prismaMock.paymentIntent.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('payments from any network (deposit-assets, quote, deposits)', () => {
    const REFUND = 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy';

    it('lists assets with no key, on its own per-address budget, for a payable link only', async () => {
      const res = await request(http())
        .get('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/deposit-assets')
        .set('x-consumer-username', 'cosmos_u1')
        .expect(400);

      expect(res.body).toMatchObject({
        code: 'validation_failed',
        message:
          'This payment link cannot be paid from another network: it is a transaction for one known payer.',
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['ratelimit-limit']).toBe(
        String(PAYMENT_DEPOSIT_ASSETS_RATE_LIMIT.limit),
      );
      expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();
      const [[, key]] = prismaMock.$queryRaw.mock.calls as [unknown, string][];
      expect(key).toMatch(/^payment-links:deposit-assets:anonymous:/);
    });

    it('answers an unknown link as not found, for the quote and the deposit', async () => {
      for (const path of ['quote', 'deposits']) {
        const res = await request(http())
          .post(`/v1/payment-links/cmh4x2k9a0009l70gneverwas/${path}`)
          .send({
            originChain: 'tron',
            originAsset: 'USDT',
            refundTo: REFUND,
            // A deposit also takes the payer's email; a quote does not.
            ...(path === 'deposits' ? { email: 'payer@example.com' } : {}),
          })
          .expect(404);
        expect(res.body.code).toBe('not_found');
      }
    });

    it('refuses a refund address of another network before reading the link', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0003l70gbaseusdc0/quote')
        .send({
          originChain: 'tron',
          originAsset: 'USDT',
          refundTo: EVM_MERCHANT,
        })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(prismaMock.paymentIntent.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a link that cannot be paid from another network, naming why', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0002l70gmonaddep/deposits')
        .send({ originChain: 'tron', originAsset: 'USDT', refundTo: REFUND })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      const keys = prismaMock.$queryRaw.mock.calls.map(
        ([, key]: [unknown, string]) => key,
      );
      expect(keys[0]).toMatch(/^payment-links:deposits:anonymous:/);
    });

    it('reads a deposit only through its own link, with no key', async () => {
      const res = await request(http())
        .get(
          '/v1/payment-links/cmh4x2k9a0003l70gbaseusdc0/deposits/cm3dep0s1t0001l70g8v5q3z2w',
        )
        .expect(404);
      expect(res.body.code).toBe('not_found');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(prismaMock.paymentDeposit.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'cm3dep0s1t0001l70g8v5q3z2w',
          intentId: 'cmh4x2k9a0003l70gbaseusdc0',
        },
      });
      const [[, key]] = prismaMock.$queryRaw.mock.calls as [unknown, string][];
      expect(key).toMatch(/^payment-links:deposit-read:anonymous:/);
    });
  });

  describe("POST /v1/payment-links/{id}/payer (the payer's email for the receipt)", () => {
    it('is reachable with no key, on its own per-address budget, and records on an open link', async () => {
      prismaMock.$executeRaw = jest.fn().mockResolvedValue(1);
      await request(http())
        .post('/v1/payment-links/cmh4x2k9a0003l70gbaseusdc0/payer')
        .set('x-consumer-username', 'cosmos_u1')
        .send({ email: 'payer@example.com', lang: 'es' })
        .expect(204);
      expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();
      const [[, key]] = prismaMock.$queryRaw.mock.calls as [unknown, string][];
      expect(key).toMatch(/^payment-links:payer:anonymous:/);
    });

    it('refuses what is not an email before reading anything', async () => {
      prismaMock.$executeRaw = jest.fn();
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0003l70gbaseusdc0/payer')
        .send({ email: 'not an email' })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses a deposit without the payer email', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0003l70gbaseusdc0/deposits')
        .send({
          originChain: 'tron',
          originAsset: 'USDT',
          refundTo: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy',
        })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(prismaMock.paymentIntent.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/payment-links/{id}/transaction', () => {
    const PAYER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

    it('is reachable with no key, on its own per-address budget', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0009l70gneverwas/transaction')
        .set('x-consumer-username', 'cosmos_u1')
        .send({ account: PAYER })
        .expect(404);

      expect(res.body.code).toBe('not_found');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['ratelimit-limit']).toBe(
        String(PAYMENT_LINK_TRANSACTION_RATE_LIMIT.limit),
      );
      expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();
      const [[, key]] = prismaMock.$queryRaw.mock.calls as [unknown, string][];
      expect(key).toMatch(/^payment-links:transaction:anonymous:/);
    });

    it('refuses a link that pays its destination directly, before any network read', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/transaction')
        .send({ account: PAYER })
        .expect(400);

      expect(res.body).toMatchObject({
        code: 'validation_failed',
        message:
          'This payment link pays its destination directly: open its uri',
      });
    });

    it('refuses an account that is not a Stellar account', async () => {
      const res = await request(http())
        .post('/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/transaction')
        .send({ account: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' })
        .expect(400);

      expect(res.body.code).toBe('validation_failed');
      expect(prismaMock.paymentIntent.findUnique).not.toHaveBeenCalled();
    });
  });
});
