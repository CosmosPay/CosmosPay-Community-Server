import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import {
  ALIAS_CHALLENGE_RATE_LIMIT,
  ALIAS_RECOVERY_COMPLETE_RATE_LIMIT,
} from '@/aliases/aliases.constants';

/**
 * Alias recovery (e2e).
 *
 * Starting a recovery returns the token that stands for control of the owner's
 * mailbox, for the platform console to email. So the route is closed to every
 * API-key caller — an `admin` key included, since it clears every scope check —
 * and the refusal happens BEFORE the alias is looked up, so it reveals nothing
 * about whether the handle or the mailbox exist.
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
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'rec_1' }),
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

  /** The platform console. */
  const asConsole = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_console')
      .set('x-cosmos-internal', '1');

  it('refuses an API-key caller before looking the alias up', async () => {
    const res = await apiKey(
      request(http()).post(path).send({ email: 'owner@example.com' }),
    ).expect(403);

    expect(res.body.code).toBe('admin_console_only');
    expect(res.body).not.toHaveProperty('token');
    expect(prismaMock.alias.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.aliasRecovery.create).not.toHaveBeenCalled();
  });

  it('refuses the internal marker when the call did not come through the gateway', async () => {
    const res = await request(http())
      .post(path)
      .set('x-cosmos-internal', '1')
      .send({ email: 'owner@example.com' })
      .expect(403);

    expect(res.body.code).toBe('gateway_required');
    expect(prismaMock.alias.findUnique).not.toHaveBeenCalled();
  });

  it('hands the console a token for a matching mailbox', async () => {
    const res = await asConsole(
      request(http()).post(path).send({ email: 'OWNER@example.com' }),
    ).expect(201);

    expect(res.body.accepted).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.email).toBe('owner@example.com');
    expect(prismaMock.aliasRecovery.create).toHaveBeenCalledTimes(1);
  });

  it('answers the console identically when the mailbox does not match', async () => {
    const res = await asConsole(
      request(http()).post(path).send({ email: 'guess@example.com' }),
    ).expect(201);

    expect(res.body).toEqual({
      accepted: true,
      token: null,
      email: null,
      expiresAt: null,
    });
    expect(prismaMock.aliasRecovery.create).not.toHaveBeenCalled();
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
