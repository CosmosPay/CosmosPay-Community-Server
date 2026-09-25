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

/**
 * What stands in front of the wallet sign-in routes.
 *
 * The claim this suite exists to prove is the one the module is designed
 * around: the OAuth callback is reachable by a BROWSER with no credential at
 * all, and every other route is reachable by a wallet holding the SHARED public
 * key — the credential a wallet has before it has an account. Get either wrong
 * and the feature is either unreachable or open.
 *
 * The three failures it pins:
 *
 *  - the callback answering only with a gateway key, which a navigation cannot
 *    present, so the flow dies silently at the redirect;
 *  - the sign-in routes refusing the public key, which would make signing in
 *    require the account that signing in exists to create;
 *  - the callback leaking the identity into the page, which would hand it to a
 *    browser this service does not control instead of to the device holding the
 *    PKCE verifier.
 */
describe('Wallet sign-in guards (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const counters = new Map<string, number>();

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) =>
      typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg),
    $queryRaw: jest.fn((_parts: unknown, key: string, windowStart: Date) => {
      const bucket = `${key}|${windowStart.getTime()}`;
      const next = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, next);
      return Promise.resolve([{ count: next }]);
    }),
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'consumer_1', apisixUsername: 'cosmos_u1' }),
    },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    walletAuthHandshake: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    walletLoginCode: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    walletAccount: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'acc_1' }),
    },
    walletBackup: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
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
    // The same filter main.ts installs: without it the error envelope in these
    // assertions is not the one an integrator receives.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    counters.clear();
    prismaMock.walletAuthHandshake.findUnique.mockClear();
    prismaMock.walletAuthHandshake.create.mockClear();
  });

  const http = () => app.getHttpServer();

  /**
   * A wallet with no account: the SHARED public key.
   *
   * Both signals PublicKeyGuard looks at are set — the configured consumer name
   * and the forwarded role — because it matches on either alone and a test that
   * set only one would pass while the other was broken.
   */
  const asPublicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  /** An ordinary account key. */
  const asAccountKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'admin');

  describe('the OAuth callback', () => {
    const path = '/v1/wallet/auth/oauth/callback/google';

    it('answers a browser that presents no credential at all', async () => {
      // No gateway secret, no consumer, no key — exactly what a redirect from
      // Google carries.
      const res = await request(http()).get(`${path}?state=nope`).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('never puts an identity or a token in the page', async () => {
      prismaMock.walletAuthHandshake.findUnique.mockResolvedValueOnce({
        state: 'st',
        provider: 'GOOGLE',
        codeChallenge: 'c',
        status: 'AUTHORIZED',
        email: 'ada@example.com',
        name: 'Ada',
        avatar: null,
        subject: '123',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const res = await request(http()).get(`${path}?state=st`).expect(200);

      expect(res.text).not.toContain('ada@example.com');
      expect(res.text).not.toContain('sessionToken');
      // Inert: no script, no external asset.
      expect(res.text).not.toMatch(/<script/i);
    });

    it('renders a page rather than an error, because the reader is a person', async () => {
      const res = await request(http()).get(`${path}?state=nope`).expect(200);
      expect(res.text).toContain('Start again from your wallet');
      // No consumer is read on a public route, so nothing here can 401/403.
      expect(res.text).not.toContain('no_authenticated_consumer');
    });
  });

  describe('the wallet routes', () => {
    it('admits the shared public key, which is all a wallet has before it has an account', async () => {
      await asPublicKey(
        request(http()).get('/v1/wallet/auth/providers'),
      ).expect(200);
    });

    it('admits an account key too', async () => {
      await asAccountKey(
        request(http()).get('/v1/wallet/auth/providers'),
      ).expect(200);
    });

    it('refuses a call that did not come through the gateway', async () => {
      const res = await request(http())
        .get('/v1/wallet/auth/providers')
        .set('x-consumer-username', 'cosmos_u1')
        .expect(403);
      expect(res.body.code).toBe('gateway_required');
    });

    it('validates the body before it touches the database', async () => {
      const res = await asPublicKey(
        request(http())
          .post('/v1/wallet/auth/oauth/authorize')
          .send({ provider: 'pollar', codeChallenge: 'short' }),
      ).expect(400);

      expect(res.body.code).toBe('validation_failed');
      expect(prismaMock.walletAuthHandshake.create).not.toHaveBeenCalled();
    });

    it('refuses a finish with no bearer token before verifying anything', async () => {
      const res = await asPublicKey(
        request(http()).post('/v1/wallet/auth/finish').send({
          stellarAddress:
            'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57',
          signedAt: '2026-01-02T03:04:05Z',
          signature: 'AAAA',
        }),
      ).expect(401);

      expect(res.body.code).toBe('wallet_session_invalid');
      expect(prismaMock.walletAccount.upsert).not.toHaveBeenCalled();
    });
  });
});
