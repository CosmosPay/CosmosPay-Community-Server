import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { MailerService } from '@/mailer/mailer.service';
import {
  ALIAS_CHALLENGE_RATE_LIMIT,
  ALIAS_RECOVERY_COMPLETE_RATE_LIMIT,
  ALIAS_RECOVERY_START_RATE_LIMIT,
} from '@/aliases/aliases.constants';

/**
 * Alias recovery (e2e).
 *
 * Starting a recovery is open to any `payments:write` key, the shared public one
 * included — whoever lost their keys has no account. That is only safe because
 * the token, which stands for control of the owner's mailbox, is EMAILED to that
 * mailbox and never appears in the response: the answer is `{ accepted: true }`
 * whether or not the handle exists and the mailbox matched.
 *
 * Completing one is open to any `payments:write` key, and handles are public,
 * so a junk token must write nothing and the route must carry a rate limit.
 */
describe('Alias recovery (e2e)', () => {
  let app: INestApplication;
  const counters = new Map<string, number>();

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  const alias = {
    id: 'al_1',
    consumerId: 'consumer_1',
    name: 'emanuel250',
    displayName: 'emanuel250',
    email: 'owner@example.com',
    emailVerifiedAt: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) =>
      typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg),
    // The rate limiter's atomic upsert, as an in-memory counter.
    $queryRaw: jest.fn((_parts: unknown, key: string, windowStart: Date) => {
      const bucket = `${key}|${windowStart.getTime()}`;
      const next = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, next);
      return Promise.resolve([{ count: next }]);
    }),
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'consumer_2', apisixUsername: 'cosmos_u1' }),
    },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    alias: { findUnique: jest.fn() },
    aliasChallenge: {
      create: jest.fn().mockResolvedValue({ id: 'ch_1' }),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    aliasRecovery: {
      // No stored hash matches a junk token.
      findUnique: jest.fn().mockResolvedValue(null),
      // No recovery started in the resend window.
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'rec_1' }),
    },
  };

  // A sender that records instead of sending: the suite asserts WHERE the token goes.
  const mailer = {
    configured: true,
    send: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(MailerService)
      .useValue(mailer)
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    counters.clear();
    prismaMock.alias.findUnique.mockReset().mockResolvedValue(alias);
    prismaMock.aliasRecovery.create.mockClear();
    prismaMock.aliasRecovery.updateMany.mockClear();
    prismaMock.aliasChallenge.create.mockClear();
    prismaMock.aliasChallenge.updateMany.mockClear();
  });

  const http = () => app.getHttpServer();
  const path = '/v1/aliases/emanuel250/recovery';

  /** An ordinary API key — an `admin` one, which clears every scope check. */
  const apiKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'admin');

  /** A wallet with no account: the SHARED public key. */
  const publicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  const flush = () => new Promise((r) => setImmediate(r));

  describe('starting a recovery', () => {
    beforeEach(() => mailer.send.mockClear());

    it('accepts the shared public key, and emails the token instead of returning it', async () => {
      const res = await publicKey(
        request(http()).post(path).send({ email: 'OWNER@example.com' }),
      ).expect(201);
      await flush();

      expect(res.body).toEqual({ accepted: true });
      expect(prismaMock.aliasRecovery.create).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send.mock.calls[0][0].to).toBe('owner@example.com');
    });

    it('answers identically when the mailbox does not match, and sends nothing', async () => {
      const res = await apiKey(
        request(http()).post(path).send({ email: 'guess@example.com' }),
      ).expect(201);
      await flush();

      expect(res.body).toEqual({ accepted: true });
      expect(prismaMock.aliasRecovery.create).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it('answers identically for an alias that does not exist', async () => {
      prismaMock.alias.findUnique.mockResolvedValue(null);
      const res = await apiKey(
        request(http())
          .post('/v1/aliases/nobody/recovery')
          .send({ email: 'x@example.com' }),
      ).expect(201);

      expect(res.body).toEqual({ accepted: true });
    });

    it('still refuses a call that did not come through the gateway', async () => {
      const res = await request(http())
        .post(path)
        .send({ email: 'owner@example.com' })
        .expect(403);

      expect(res.body.code).toBe('gateway_required');
      expect(prismaMock.alias.findUnique).not.toHaveBeenCalled();
    });

    it('is rate limited per address', async () => {
      const { limit } = ALIAS_RECOVERY_START_RATE_LIMIT;
      for (let i = 0; i < limit; i++) {
        await publicKey(
          request(http()).post(path).send({ email: 'guess@example.com' }),
        ).expect(201);
      }
      const refused = await publicKey(
        request(http()).post(path).send({ email: 'guess@example.com' }),
      ).expect(429);
      expect(refused.body.code).toBe('rate_limited');
    });
  });

  describe('completing a recovery', () => {
    const complete = () =>
      apiKey(
        request(http()).post(`${path}/complete`).send({
          token: 'junk-token',
          address: ADDRESS,
          network: 'public',
          nonce: 'nonce-1',
          signature: 'c2lnbmF0dXJl',
        }),
      );

    it('refuses a junk token without touching the owner’s live recovery', async () => {
      const res = await complete().expect(400);

      expect(res.body.code).toBe('alias_recovery_invalid');
      expect(res.body.message).toBe(
        'The recovery token is unknown, expired or already used.',
      );
      // A junk token used to count against the alias's live recovery, so any
      // key could burn it: the handle is public.
      expect(prismaMock.aliasRecovery.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.aliasChallenge.updateMany).not.toHaveBeenCalled();
    });

    it('is rate limited, and refuses before the alias is looked up', async () => {
      const { limit } = ALIAS_RECOVERY_COMPLETE_RATE_LIMIT;

      for (let i = 0; i < limit; i++) {
        const res = await complete().expect(400);
        expect(Number(res.headers['ratelimit-limit'])).toBe(limit);
        expect(Number(res.headers['ratelimit-remaining'])).toBe(limit - 1 - i);
      }

      prismaMock.alias.findUnique.mockClear();
      const refused = await complete().expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(prismaMock.alias.findUnique).not.toHaveBeenCalled();
      // Every one of those junk attempts left the recovery table alone.
      expect(prismaMock.aliasRecovery.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('issuing challenges', () => {
    const challenge = () =>
      apiKey(
        request(http())
          .post('/v1/aliases/challenges')
          .send({ name: 'emanuel250', address: ADDRESS, network: 'public' }),
      );

    it('is rate limited, and a refused call stores no challenge', async () => {
      const { limit } = ALIAS_CHALLENGE_RATE_LIMIT;

      for (let i = 0; i < limit; i++) {
        const res = await challenge().expect(201);
        expect(Number(res.headers['ratelimit-limit'])).toBe(limit);
        expect(Number(res.headers['ratelimit-remaining'])).toBe(limit - 1 - i);
      }
      expect(prismaMock.aliasChallenge.create).toHaveBeenCalledTimes(limit);

      const refused = await challenge().expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(prismaMock.aliasChallenge.create).toHaveBeenCalledTimes(limit);
    });

    it('leaves the payer-side reads unlimited', async () => {
      const res = await apiKey(
        request(http()).get('/v1/aliases/availability/emanuel250'),
      ).expect(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    });
  });
});
