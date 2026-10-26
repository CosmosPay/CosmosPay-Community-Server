import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { recordToken, recordTokenKey } from '@/common/public-record-token';
import type { PublicRecordKind } from '@/common/public-record-token.constants';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import { PrismaService } from '@/prisma/prisma.service';
import { SignedTransactionRelay } from '@/stellar/signed-transaction-relay.service';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';

/**
 * The per-record read token of what the SHARED public key creates.
 *
 * That key is one consumer for every anonymous visitor, and anyone can fetch
 * it, so a record id alone must not read (or act on) another visitor's swap.
 * A create on that key answers `publicToken`; the reads and actions of one
 * record then need it in `X-Record-Token`, and a missing or wrong one is the
 * same 404 as a record that does not exist, decided before the table is read.
 * A real key is unaffected.
 *
 * Swap submit and cross-chain deposit predate the tokens and the wallet calls
 * them with the public key, so there a missing token is still accepted (and
 * logged as deprecated) until PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY is on; a
 * wrong token is refused there too.
 */
describe('Public record tokens (e2e)', () => {
  let app: NestExpressApplication;

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const KEY = recordTokenKey(SECRET);
  const tokenOf = (kind: PublicRecordKind, id: string) =>
    recordToken(KEY, kind, id);

  const SWAP_ID = 'cm1swapstellar00000000001';
  const CHAIN_SWAP_ID = 'cm1swapchain0000000000001';
  const CROSS_ID = 'cm1swapcross0000000000001';
  const USDT0_ID = 'cm1usdt0transfer000000001';
  const NOW = new Date('2026-10-25T12:00:00Z');

  const ROWS = {
    swap: {
      id: SWAP_ID,
      status: 'PENDING',
      network: 'public',
      source: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
      feeAmount: '0',
      memo: null,
      xdr: 'AAAA',
      uri: 'web+stellar:tx?xdr=AAAA',
      txHash: 'ab'.repeat(32),
      createdAt: NOW,
      updatedAt: NOW,
    },
    chainSwap: {
      id: CHAIN_SWAP_ID,
      chain: 'solana',
      status: 'PENDING',
      source: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
      createdAt: NOW,
      updatedAt: NOW,
    },
    crossChainSwap: {
      id: CROSS_ID,
      status: 'AWAITING_DEPOSIT',
      originChain: 'btc',
      depositAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      depositMemo: null,
      depositUri: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: NOW,
      updatedAt: NOW,
    },
    usdt0Transfer: {
      id: USDT0_ID,
      // Final: a read answers from the row, with no upstream refresh.
      status: 'DELIVERED',
      network: 'public',
      amount: '10',
      amountSent: '10',
      uri: 'web+stellar:tx?xdr=AAAA',
      txHash: 'cd'.repeat(32),
      guid: `0x${'ef'.repeat(32)}`,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };

  const counters = new Map<string, number>();
  const table = (row: unknown) => ({
    findFirst: jest.fn().mockResolvedValue(row),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  });
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
    consumer: {
      upsert: jest.fn().mockResolvedValue({ id: 'consumer_public' }),
    },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    swap: table(ROWS.swap),
    chainSwap: table(null),
    crossChainSwap: {
      ...table(ROWS.crossChainSwap),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'cm1crosscreated0000000001',
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        }),
      ),
    },
    usdt0Transfer: table(ROWS.usdt0Transfer),
  };

  const nearIntentsMock = {
    tokens: jest.fn().mockResolvedValue([
      { assetId: 'btc', decimals: 8, blockchain: 'btc', symbol: 'BTC' },
      { assetId: 'eth', decimals: 18, blockchain: 'eth', symbol: 'ETH' },
    ]),
    quote: jest.fn((req: { amount: string; deadline: string }) =>
      Promise.resolve({
        correlationId: 'corr-1',
        timestamp: NOW.toISOString(),
        signature: 'ed25519:sig',
        quoteRequest: req,
        quote: {
          amountIn: req.amount,
          amountInFormatted: '0.01',
          amountOut: '250000000000000000',
          amountOutFormatted: '0.25',
          minAmountOut: '247500000000000000',
          timeEstimate: 600,
          depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
          deadline: req.deadline,
        },
      }),
    ),
    status: jest.fn(),
    // 1Click does not know the address yet: the swap stays as it is.
    submitDeposit: jest.fn().mockResolvedValue(null),
  };

  /**
   * The relay is the swap submit's own defence (the signed envelope must be
   * the swap's); it has its own spec, and here it only answers, so a 200 means
   * the record-token check let the request through.
   */
  const relayMock = {
    submit: jest.fn().mockResolvedValue({
      submitted: true,
      status: 'SUCCEEDED',
      txHash: 'ab'.repeat(32),
      view: { id: SWAP_ID },
    }),
  };

  async function buildApp(): Promise<NestExpressApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(NearIntentsClient)
      .useValue(nearIntentsMock)
      .overrideProvider(SorobanRpcClient)
      .useValue({ passphrase: 'unused' })
      .overrideProvider(LayerZeroScanClient)
      .useValue({})
      .overrideProvider(SignedTransactionRelay)
      .useValue(relayMock)
      .compile();

    const built = moduleRef.createNestApplication<NestExpressApplication>();
    built.set('trust proxy', 1);
    built.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    built.useGlobalFilters(new AllExceptionsFilter());
    built.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await built.init();
    return built;
  }

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    counters.clear();
    for (const model of [
      prismaMock.swap,
      prismaMock.chainSwap,
      prismaMock.crossChainSwap,
      prismaMock.usdt0Transfer,
    ]) {
      model.findFirst.mockClear();
    }
  });

  const PUBLIC_KEY = {
    'x-gateway-secret': SECRET,
    'x-consumer-username': 'cosmos_wallet',
    'x-consumer-role': 'public',
    'x-consumer-env': 'prod',
    'x-plan-swap-fee-bps': '0',
    'x-consumer-permissions': 'swaps:read,swaps:write',
  };
  const REAL_KEY = {
    ...PUBLIC_KEY,
    'x-consumer-username': 'cosmos_u1',
    'x-consumer-role': 'user',
  };

  type Read = {
    label: string;
    path: string;
    kind: PublicRecordKind;
    id: string;
    model: { findFirst: jest.Mock };
  };
  const READS: Read[] = [
    {
      label: 'a Stellar swap',
      path: `/v1/swaps/${SWAP_ID}`,
      kind: 'swap',
      id: SWAP_ID,
      model: prismaMock.swap,
    },
    {
      label: 'a cross-chain swap',
      path: `/v1/cross-chain-swaps/${CROSS_ID}`,
      kind: 'cross-chain-swap',
      id: CROSS_ID,
      model: prismaMock.crossChainSwap,
    },
    {
      label: 'a USDT0 transfer',
      path: `/v1/usdt0/transfers/${USDT0_ID}`,
      kind: 'usdt0-transfer',
      id: USDT0_ID,
      model: prismaMock.usdt0Transfer,
    },
  ];

  describe.each(READS)('reading $label by id', ({ path, kind, id, model }) => {
    it('works on the shared public key with the record’s token', async () => {
      const res = await request(app.getHttpServer())
        .get(path)
        .set(PUBLIC_KEY)
        .set('X-Record-Token', tokenOf(kind, id))
        .expect(200);
      expect(res.body.id).toBe(id);
      expect(model.findFirst).toHaveBeenCalledWith({
        where: { id, consumer: { apisixUsername: 'cosmos_wallet' } },
      });
    });

    it.each([
      ['no token', undefined],
      ['another record’s token', 'cm1someotherrecord0000001'],
      ['another kind’s token for the same id', 'other-kind'],
    ])(
      'answers %s with the 404 of a missing record, before the table is read',
      async (_label, variant) => {
        const call = request(app.getHttpServer()).get(path).set(PUBLIC_KEY);
        if (variant === 'other-kind') {
          const other: PublicRecordKind =
            kind === 'swap' ? 'cross-chain-swap' : 'swap';
          call.set('X-Record-Token', tokenOf(other, id));
        } else if (variant) {
          call.set('X-Record-Token', tokenOf(kind, variant));
        }
        const res = await call.expect(404);
        expect(res.body.code).toBe('not_found');
        expect(res.body.message).toMatch(new RegExp(`${id} not found$`));
        expect(model.findFirst).not.toHaveBeenCalled();
      },
    );

    it('is unchanged for a real key: no token asked', async () => {
      const res = await request(app.getHttpServer())
        .get(path)
        .set(REAL_KEY)
        .expect(200);
      expect(res.body.id).toBe(id);
      expect(model.findFirst).toHaveBeenCalledWith({
        where: { id, consumer: { apisixUsername: 'cosmos_u1' } },
      });
    });
  });

  it('reads a Solana or Monad swap through /v1/swaps/{id} only with its own kind’s token', async () => {
    prismaMock.chainSwap.findFirst.mockResolvedValueOnce(ROWS.chainSwap);
    const res = await request(app.getHttpServer())
      .get(`/v1/swaps/${CHAIN_SWAP_ID}`)
      .set(PUBLIC_KEY)
      .set('X-Record-Token', tokenOf('chain-swap', CHAIN_SWAP_ID))
      .expect(200);
    expect(res.body.id).toBe(CHAIN_SWAP_ID);

    prismaMock.chainSwap.findFirst.mockClear();
    prismaMock.swap.findFirst.mockClear();
    // A Stellar swap's token for the same id opens neither table's row.
    await request(app.getHttpServer())
      .get(`/v1/swaps/${CHAIN_SWAP_ID}`)
      .set(PUBLIC_KEY)
      .set('X-Record-Token', tokenOf('swap', 'cm1someotherrecord0000001'))
      .expect(404);
    expect(prismaMock.chainSwap.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.swap.findFirst).not.toHaveBeenCalled();
  });

  it('refuses POST /v1/usdt0/transfers/{id}/submit on the shared public key without the token (404): it is new, so it requires it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/usdt0/transfers/${USDT0_ID}/submit`)
      .set(PUBLIC_KEY)
      .set('x-forwarded-for', '192.0.2.44')
      .send({ signedXdr: 'AAAA' })
      .expect(404);
    expect(res.body.code).toBe('not_found');
    expect(prismaMock.usdt0Transfer.findFirst).not.toHaveBeenCalled();
  });

  type Legacy = {
    route: string;
    path: string;
    body: Record<string, string>;
    kind: PublicRecordKind;
    id: string;
    model: { findFirst: jest.Mock };
  };
  const LEGACY: Legacy[] = [
    {
      route: 'POST /v1/swaps/{id}/submit',
      path: `/v1/swaps/${SWAP_ID}/submit`,
      body: { signedXdr: 'AAAA' },
      kind: 'swap',
      id: SWAP_ID,
      model: prismaMock.swap,
    },
    {
      route: 'POST /v1/cross-chain-swaps/{id}/deposit',
      path: `/v1/cross-chain-swaps/${CROSS_ID}/deposit`,
      body: { txHash: 'ab'.repeat(32) },
      kind: 'cross-chain-swap',
      id: CROSS_ID,
      model: prismaMock.crossChainSwap,
    },
  ];
  const deprecations = (warn: jest.SpyInstance) =>
    warn.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry?.event === 'public_record_token_missing');

  describe.each(LEGACY)('the legacy route $route', (legacy) => {
    let address = 10;
    const post = (token?: string) => {
      address += 1;
      const call = request(app.getHttpServer())
        .post(legacy.path)
        .set(PUBLIC_KEY)
        .set('x-forwarded-for', `198.51.100.${address}`);
      if (token !== undefined) call.set('X-Record-Token', token);
      return call.send(legacy.body);
    };

    afterEach(() => jest.restoreAllMocks());

    it('still answers the shared public key without a token, and logs a deprecation naming the route and the record', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await post().expect(200);
      expect(legacy.model.findFirst).toHaveBeenCalledWith({
        where: {
          id: legacy.id,
          consumer: { apisixUsername: 'cosmos_wallet' },
        },
      });
      expect(deprecations(warn)).toEqual([
        expect.objectContaining({
          deprecated: true,
          route: legacy.route,
          recordKind: legacy.kind,
          recordId: legacy.id,
        }),
      ]);
    });

    it('answers the record’s own token without a deprecation', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await post(tokenOf(legacy.kind, legacy.id)).expect(200);
      expect(deprecations(warn)).toEqual([]);
    });

    it('refuses a wrong token with the 404 of a missing record, before the table is read', async () => {
      const res = await post(
        tokenOf(legacy.kind, 'cm1someotherrecord0000001'),
      ).expect(404);
      expect(res.body.code).toBe('not_found');
      expect(legacy.model.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('with PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY=true', () => {
    let strict: NestExpressApplication;

    beforeAll(async () => {
      process.env.PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY = 'true';
      strict = await buildApp();
    });

    afterAll(async () => {
      delete process.env.PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY;
      await strict.close();
    });

    it.each(LEGACY)(
      'refuses $route on the shared public key without the token (404)',
      async (legacy) => {
        const res = await request(strict.getHttpServer())
          .post(legacy.path)
          .set(PUBLIC_KEY)
          .set('x-forwarded-for', '203.0.113.200')
          .send(legacy.body)
          .expect(404);
        expect(res.body.code).toBe('not_found');
        expect(legacy.model.findFirst).not.toHaveBeenCalled();
      },
    );

    it.each(LEGACY)('still answers $route with the token', async (legacy) => {
      await request(strict.getHttpServer())
        .post(legacy.path)
        .set(PUBLIC_KEY)
        .set('X-Record-Token', tokenOf(legacy.kind, legacy.id))
        .set('x-forwarded-for', '203.0.113.201')
        .send(legacy.body)
        .expect(200);
    });
  });

  describe('creating a record', () => {
    const body = {
      originChain: 'btc',
      originAsset: 'BTC',
      destinationChain: 'eth',
      destinationAsset: 'ETH',
      amount: '0.01',
      recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      refundTo: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    it('answers publicToken to the shared public key, and that token reads the record', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/cross-chain-swaps')
        .set(PUBLIC_KEY)
        .set('x-forwarded-for', '192.0.2.45')
        .send(body)
        .expect(201);
      expect(created.body.publicToken).toBe(
        tokenOf('cross-chain-swap', created.body.id),
      );

      prismaMock.crossChainSwap.findFirst.mockResolvedValueOnce({
        ...ROWS.crossChainSwap,
        id: created.body.id,
      });
      const read = await request(app.getHttpServer())
        .get(`/v1/cross-chain-swaps/${created.body.id}`)
        .set(PUBLIC_KEY)
        .set('X-Record-Token', created.body.publicToken)
        .expect(200);
      expect(read.body.id).toBe(created.body.id);
      expect(read.body).not.toHaveProperty('publicToken');
    });

    it('answers no publicToken to a real key', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/cross-chain-swaps')
        .set(REAL_KEY)
        .set('x-forwarded-for', '192.0.2.46')
        .send(body)
        .expect(201);
      expect(created.body.id).toBeDefined();
      expect(created.body).not.toHaveProperty('publicToken');
    });
  });
});
