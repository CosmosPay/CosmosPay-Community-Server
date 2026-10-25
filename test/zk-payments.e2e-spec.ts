import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';
import {
  ConfidentialSdk,
  type ZkTransactionRead,
} from '@/zk-payments/confidential-sdk';
import { ZK_PAYMENT_PUBLIC_READ_RATE_LIMIT } from '@/zk-payments/zk-payments.constants';
import { withGatewayAuth } from './gateway-auth';

/**
 * ZK payments through the real pipes, guards and filters: the merchant's
 * `/v1/zk-payments` behind the gateway, and the payer's keyless
 * `/v1/zk-checkout`. Prisma is an in-memory table and the confidential token
 * SDK adapter is replaced, so no RPC is called (`scripts/zk/e2e-testnet.ts` is
 * the real-chain check). The testnet set comes from `test/setup-env.ts`.
 */
describe('ZK payments (e2e)', () => {
  let app: INestApplication;

  const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
  const MERCHANT = 'GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP';
  const FEE_ACCOUNT =
    'GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N';
  const PAYER = 'GADAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDANWXK';
  const PAYMENT_TX = 'a'.repeat(64);
  const FEE_TX = 'b'.repeat(64);

  const rows: Record<string, unknown>[] = [];
  const rateLimitCounters = new Map<string, number>();

  const pick = (row: Record<string, unknown>, select?: object) => {
    if (!select) return { ...row };
    return Object.fromEntries(
      Object.keys(select).map((k) =>
        k === 'consumer' ? [k, { apisixUsername: 'cosmos_u1' }] : [k, row[k]],
      ),
    );
  };

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    consumer: {
      upsert: jest.fn().mockResolvedValue({ id: 'consumer_1' }),
    },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    webhookEmittedEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prismaMock)),
    $queryRaw: jest.fn((_sql: unknown, key: string) => {
      const next = (rateLimitCounters.get(key) ?? 0) + 1;
      rateLimitCounters.set(key, next);
      return Promise.resolve([{ count: next }]);
    }),
    zkPayment: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `cmzk${rows.length + 1}`,
          status: 'PENDING',
          payer: null,
          paymentTxHash: null,
          feeTxHash: null,
          settledAt: null,
          createdAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return Promise.resolve({ ...row });
      }),
      findUnique: jest.fn(({ where, select }: any) => {
        const key = where.consumerId_idempotencyKey;
        const row = rows.find((r) =>
          key
            ? r.consumerId === key.consumerId &&
              r.idempotencyKey === key.idempotencyKey
            : r.id === where.id,
        );
        return Promise.resolve(row ? pick(row, select) : null);
      }),
      findUniqueOrThrow: jest.fn(({ where, select }: any) =>
        Promise.resolve(
          pick(
            rows.find((r) => r.id === where.id)!,
            select,
          ),
        ),
      ),
      findFirst: jest.fn(({ where, select }: any) => {
        if (where.OR) return Promise.resolve(null);
        const row = rows.find((r) => r.id === where.id);
        return Promise.resolve(row ? pick(row, select) : null);
      }),
      findMany: jest.fn(({ select }: any) =>
        Promise.resolve(rows.map((r) => pick(r, select))),
      ),
      count: jest.fn(() => Promise.resolve(rows.length)),
      updateMany: jest.fn(({ where, data }: any) => {
        const row = rows.find(
          (r) => r.id === where.id && r.status === where.status,
        );
        if (!row) return Promise.resolve({ count: 0 });
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      }),
    },
  };

  const success = (
    txHash: string,
    to: string,
    amount: bigint,
  ): ZkTransactionRead => ({
    status: 'success',
    txHash,
    ledger: 100,
    closedAt: new Date(),
    operationCount: 1,
    invocation: { contract: TOKEN, function: 'confidential_transfer' },
    transfers: [
      { from: PAYER, to, amount, channelsAgree: true, commitmentMatches: true },
    ],
  });

  const sdkMock = {
    account: jest.fn(),
    readTransaction: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(ConfidentialSdk)
      .useValue(sdkMock)
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
    sdkMock.account.mockReset();
    sdkMock.readTransaction.mockReset();
    sdkMock.account.mockResolvedValue({ registered: true, auditorId: 0 });
  });

  const http = () => app.getHttpServer();
  const merchant = (req: request.Test) =>
    withGatewayAuth(req)
      .set('x-consumer-env', 'dev')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  describe('/v1/zk-payments (API key)', () => {
    it('refuses a request that did not come through the gateway', async () => {
      await request(http()).get('/v1/zk-payments/config').expect(403);
      await request(http())
        .post('/v1/zk-payments')
        .send({ amount: '25', recipient: MERCHANT })
        .expect(403);
    });

    it('serves the config of the key network', async () => {
      const res = await merchant(
        request(http()).get('/v1/zk-payments/config'),
      ).expect(200);
      expect(res.body).toMatchObject({
        enabled: true,
        network: 'testnet',
        token: { contractId: TOKEN, symbol: 'XLM', decimals: 7 },
        auditorId: 0,
        feeBps: 1,
        feeAccount: FEE_ACCOUNT,
      });
    });

    it('answers enabled: false for a mainnet key', async () => {
      const res = await withGatewayAuth(
        request(http()).get('/v1/zk-payments/config'),
      )
        .set('x-consumer-env', 'prod')
        .expect(200);
      expect(res.body).toMatchObject({ enabled: false, network: 'public' });
    });

    it('validates the body through the pipe', async () => {
      const res = await merchant(request(http()).post('/v1/zk-payments'))
        .send({ amount: '1.00000001', recipient: 'nope', network: 'public' })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('refuses a mainnet key with network_unsupported', async () => {
      const res = await withGatewayAuth(request(http()).post('/v1/zk-payments'))
        .set('x-consumer-env', 'prod')
        .send({ amount: '25', recipient: MERCHANT })
        .expect(400);
      expect(res.body.code).toBe('network_unsupported');
    });

    it('refuses a recipient with no confidential account', async () => {
      sdkMock.account.mockResolvedValue({ registered: false, auditorId: null });
      const res = await merchant(request(http()).post('/v1/zk-payments'))
        .send({ amount: '25', recipient: MERCHANT })
        .expect(400);
      expect(res.body.code).toBe('recipient_not_registered');
    });

    it('creates a payment, priced at 0.01%', async () => {
      const res = await merchant(request(http()).post('/v1/zk-payments'))
        .set('idempotency-key', 'order-24')
        .send({ amount: '25', recipient: MERCHANT, description: 'Order #24' })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        network: 'testnet',
        tokenContract: TOKEN,
        amount: '25',
        netAmount: '24.9975',
        feeAmount: '0.0025',
        feeBps: 1,
        recipient: MERCHANT,
        feeAccount: FEE_ACCOUNT,
        idempotencyKey: 'order-24',
      });
      expect(res.body).not.toHaveProperty('consumerId');

      const list = await merchant(
        request(http()).get('/v1/zk-payments?status=PENDING'),
      ).expect(200);
      expect(list.body).toMatchObject({ total: 1, take: 20, skip: 0 });
    });
  });

  describe('/v1/zk-checkout (no API key)', () => {
    it('serves any network config with no credential, sharing the builder', async () => {
      const keyless = await request(http())
        .get('/v1/zk-checkout/config?network=testnet')
        .expect(200);
      const keyed = await merchant(
        request(http()).get('/v1/zk-payments/config'),
      ).expect(200);
      expect(keyless.body).toEqual(keyed.body);

      const off = await request(http())
        .get('/v1/zk-checkout/config?network=public')
        .expect(200);
      expect(off.body).toMatchObject({
        enabled: false,
        network: 'public',
        token: null,
        rpcUrl: null,
        feeAccount: null,
        auditorId: 0,
        feeBps: 1,
      });
    });

    it('requires a known network on the config', async () => {
      await request(http()).get('/v1/zk-checkout/config').expect(400);
      await request(http())
        .get('/v1/zk-checkout/config?network=mainnet')
        .expect(400);
    });

    it('serves the payer view, uncached, with no CORS header of its own', async () => {
      const id = rows[0].id as string;
      const res = await request(http())
        .get(`/v1/zk-checkout/${id}`)
        .expect(200);
      expect(res.body).toMatchObject({
        id,
        status: 'PENDING',
        amount: '25',
        netAmount: '24.9975',
        feeAmount: '0.0025',
        recipient: MERCHANT,
        feeAccount: FEE_ACCOUNT,
        network: 'testnet',
        auditorId: 0,
        token: { contractId: TOKEN },
      });
      for (const field of [
        'consumerId',
        'idempotencyKey',
        'paymentTxHash',
        'feeTxHash',
        'payer',
      ]) {
        expect(res.body).not.toHaveProperty(field);
      }
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['ratelimit-limit']).toBe(
        String(ZK_PAYMENT_PUBLIC_READ_RATE_LIMIT.limit),
      );
    });

    it('answers an unknown id with the not-found envelope', async () => {
      const res = await request(http())
        .get('/v1/zk-checkout/cmzk-never')
        .expect(404);
      expect(res.body).toMatchObject({
        code: 'not_found',
        message: 'ZK payment cmzk-never not found',
      });
    });

    it('validates the confirm body', async () => {
      const id = rows[0].id as string;
      const res = await request(http())
        .post(`/v1/zk-checkout/${id}/confirm`)
        .send({ paymentTxHash: 'nope' })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(sdkMock.readTransaction).not.toHaveBeenCalled();
    });

    it('refuses a transfer the chain does not back, and leaves it PENDING', async () => {
      const id = rows[0].id as string;
      sdkMock.readTransaction.mockImplementation(
        (_t: unknown, _s: string, hash: string) =>
          Promise.resolve(
            hash === PAYMENT_TX
              ? success(PAYMENT_TX, MERCHANT, 1n)
              : success(FEE_TX, FEE_ACCOUNT, 25_000n),
          ),
      );
      const res = await request(http())
        .post(`/v1/zk-checkout/${id}/confirm`)
        .send({ paymentTxHash: PAYMENT_TX, feeTxHash: FEE_TX })
        .expect(400);
      expect(res.body.code).toBe('payment_transfer_mismatch');
      expect(rows[0].status).toBe('PENDING');
    });

    it('confirms with no credential, verified through the adapter', async () => {
      const id = rows[0].id as string;
      sdkMock.readTransaction.mockImplementation(
        (_t: unknown, _s: string, hash: string) =>
          Promise.resolve(
            hash === PAYMENT_TX
              ? success(PAYMENT_TX, MERCHANT, 249_975_000n)
              : success(FEE_TX, FEE_ACCOUNT, 25_000n),
          ),
      );
      const res = await request(http())
        .post(`/v1/zk-checkout/${id}/confirm`)
        .send({ paymentTxHash: PAYMENT_TX, feeTxHash: FEE_TX })
        .expect(200);
      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();

      const owner = await merchant(
        request(http()).get(`/v1/zk-payments/${id}`),
      ).expect(200);
      expect(owner.body).toMatchObject({
        status: 'SUCCEEDED',
        payer: PAYER,
        paymentTxHash: PAYMENT_TX,
        feeTxHash: FEE_TX,
      });
    });

    it('drops a consumer the client names on the keyless routes', async () => {
      prismaMock.consumer.upsert.mockClear();
      await request(http())
        .get('/v1/zk-checkout/config?network=testnet')
        .set('x-consumer-username', 'cosmos_u1')
        .expect(200);
      expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();
      const [[, key]] = prismaMock.$queryRaw.mock.calls.slice(-1) as [
        unknown,
        string,
      ][];
      expect(key).toMatch(/^zk-payments:public-read:anonymous:/);
    });
  });
});
