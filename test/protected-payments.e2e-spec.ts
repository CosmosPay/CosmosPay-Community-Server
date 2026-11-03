import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const MERCHANT = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

const BODY = {
  amount: '125.5',
  releaseModel: 'BUYER_RELEASES',
  deadlinePolicy: 'MANUAL_REVIEW',
  deliveryWindowHours: 168,
  merchantAddress: MERCHANT,
  title: 'Order #1042',
};

/**
 * The wiring in front of protected payments (native plugin `trustless-work`),
 * with no Trustless Work key configured (`test/setup-env.ts`).
 *
 * The merchant's routes take a real API key with the payment scopes and refuse
 * the shared public key; the buyer's link routes take no credential at all and
 * answer a value that is not a payment id with a 404 before the table is read;
 * the ops routes are the platform console's only. With no key, a merchant that
 * gets past the guards meets `503 misconfigured`, never Trustless Work.
 */
describe('Protected payments (e2e)', () => {
  let app: INestApplication;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    consumer: {
      upsert: jest.fn().mockResolvedValue({ id: 'local_merchant' }),
    },
    // The rate limiter's counter: always the first request of its window.
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    protectedPayment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
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

  beforeEach(() => {
    prismaMock.protectedPayment.findUnique.mockClear();
  });

  const http = () => app.getHttpServer();

  /** An ordinary dev (testnet) API key with the payment scopes. */
  const asMerchant = (
    r: request.Test,
    permissions = 'payments:read,payments:write',
  ) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_merchant')
      .set('x-consumer-role', 'user')
      .set('x-consumer-env', 'dev')
      .set('x-consumer-permissions', permissions);

  /** The shared public key, with the same scopes. */
  const asPublicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-env', 'dev')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  describe('the merchant routes', () => {
    it('refuse a caller that did not come through the gateway', async () => {
      const res = await request(http())
        .post('/v1/protected-payments')
        .send(BODY)
        .expect(403);
      expect(res.body.code).toBe('gateway_required');
    });

    it('refuse the shared public key: a protected payment belongs to one merchant', async () => {
      await asPublicKey(request(http()).post('/v1/protected-payments'))
        .send(BODY)
        .expect(403);
      await asPublicKey(request(http()).get('/v1/protected-payments')).expect(
        403,
      );
    });

    it('refuse a key without the payment scopes', async () => {
      await asMerchant(
        request(http()).post('/v1/protected-payments'),
        'payments:read',
      )
        .send(BODY)
        .expect(403);
    });

    it('validate the body before anything else', async () => {
      const res = await asMerchant(
        request(http()).post('/v1/protected-payments'),
      )
        .send({ ...BODY, deliveryWindowHours: 0, releaseModel: 'WHATEVER' })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('answer 503 misconfigured without a Trustless Work key, never calling it', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const res = await asMerchant(
        request(http()).post('/v1/protected-payments'),
      )
        .send(BODY)
        .expect(503);
      expect(res.body.code).toBe('misconfigured');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("answer someone else's (or a missing) payment with 404", async () => {
      const res = await asMerchant(
        request(http()).get(`/v1/protected-payments/${ID}`),
      ).expect(404);
      expect(res.body.code).toBe('not_found');
    });
  });

  describe('the buyer link routes', () => {
    it('are reachable with no key and no gateway secret, and never cached', async () => {
      const res = await request(http())
        .get(`/v1/protected-payment-links/${ID}`)
        .expect(404);
      expect(res.body.code).toBe('not_found');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(prismaMock.protectedPayment.findUnique).toHaveBeenCalledWith({
        where: { id: ID },
      });
    });

    it('answer an id that is not a uuid with 404 before the table is read', async () => {
      await request(http())
        .get('/v1/protected-payment-links/cmh4x2k9a0001l70g8v5q3z2w')
        .expect(404);
      await request(http())
        .post('/v1/protected-payment-links/not-an-id/fund')
        .send({ buyer: MERCHANT })
        .expect(404);
      expect(prismaMock.protectedPayment.findUnique).not.toHaveBeenCalled();
    });

    it('validate the fund body', async () => {
      await request(http())
        .post(`/v1/protected-payment-links/${ID}/fund`)
        .send({ buyer: 'not-an-account' })
        .expect(400);
    });
  });

  describe('the ops routes', () => {
    it('refuse an ordinary API key: they are the platform console’s only', async () => {
      await asMerchant(
        request(http()).post(`/v1/admin/protected-payments/${ID}/resolve`),
      )
        .send({ buyerAmount: '1', merchantAmount: '1' })
        .expect(403);
      await asMerchant(
        request(http()).get('/v1/admin/protected-payments'),
      ).expect(403);
    });
  });
});
