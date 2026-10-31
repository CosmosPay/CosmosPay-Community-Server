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
 * What stands in front of easy recovery, and what each answer looks like on the
 * wire — the wallet is written against these bodies and status codes.
 *
 * The routes must admit the SHARED public key (the new device has no account),
 * refuse a call that skipped the gateway, refuse a malformed key or code before
 * the table is touched, and answer the documented envelope for every refusal —
 * `details.attemptsLeft` on a wrong code included.
 */
describe('Easy recovery (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const BASE = '/v1/wallet/easy-recovery/sessions';
  const RECEIVER_KEY = 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20';
  const LOW_ORDER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const CIPHERTEXT = 'c2VhbGVkLXRvLXRoZS1uZXctZGV2aWNl';
  const CODE = '48213';

  const counters = new Map<string, number>();
  const rows = new Map<string, any>();

  /** Postgres' WHERE, for the filters the service writes. */
  const matches = (row: any, where: any) =>
    (where.id === undefined ||
      (typeof where.id === 'string'
        ? row.id === where.id
        : where.id.in.includes(row.id))) &&
    (where.status === undefined || row.status === where.status) &&
    (where.attempts?.lt === undefined || row.attempts < where.attempts.lt) &&
    (where.attempts?.gte === undefined || row.attempts >= where.attempts.gte) &&
    (where.expiresAt?.gt === undefined || row.expiresAt > where.expiresAt.gt) &&
    (where.expiresAt?.lt === undefined || row.expiresAt < where.expiresAt.lt);

  const pick = (row: any, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
      : { ...row };

  const easyRecoverySession = {
    create: jest.fn(({ data, select }: any) => {
      const row = {
        status: 'OPEN',
        ciphertext: null,
        codeHash: null,
        attempts: 0,
        createdAt: new Date(),
        ...data,
      };
      rows.set(row.id, row);
      return Promise.resolve(pick(row, select));
    }),
    findUnique: jest.fn(({ where, select }: any) => {
      const row = rows.get(where.id);
      return Promise.resolve(row ? pick(row, select) : null);
    }),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn(({ where, data }: any) => {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts) row.attempts += attempts.increment;
        count++;
      }
      return Promise.resolve({ count });
    }),
    deleteMany: jest.fn(({ where }: any) => {
      let count = 0;
      for (const row of [...rows.values()]) {
        if (matches(row, where)) {
          rows.delete(row.id);
          count++;
        }
      }
      return Promise.resolve({ count });
    }),
  };

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) =>
      typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg),
    // The rate-limit counter.
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
    easyRecoverySession,
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
    // The filter main.ts installs: the envelope asserted here is the real one.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    counters.clear();
    rows.clear();
    jest.clearAllMocks();
  });

  const http = () => app.getHttpServer();

  /** A wallet with no account: the SHARED public key. */
  const asPublicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  const open = async (): Promise<string> => {
    const res = await asPublicKey(
      request(http()).post(BASE).send({ receiverKey: RECEIVER_KEY }),
    ).expect(201);
    return res.body.id as string;
  };

  const offer = (id: string) =>
    asPublicKey(
      request(http())
        .post(`${BASE}/${id}/offer`)
        .send({ ciphertext: CIPHERTEXT, code: CODE }),
    );

  const claim = (id: string, code: string) =>
    asPublicKey(request(http()).post(`${BASE}/${id}/claim`).send({ code }));

  const poll = (id: string) =>
    asPublicKey(request(http()).get(`${BASE}/${id}`));

  describe('guards and validation', () => {
    it('admits the shared public key and answers only an id and an expiry', async () => {
      const res = await asPublicKey(
        request(http()).post(BASE).send({ receiverKey: RECEIVER_KEY }),
      ).expect(201);

      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'id']);
      expect(res.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      // Rate-limited per client: the budget headers ride on the success.
      expect(res.headers['ratelimit-limit']).toBeDefined();
    });

    it('refuses a call that did not come through the gateway', async () => {
      const res = await request(http())
        .post(BASE)
        .set('x-consumer-username', 'cosmos_public')
        .send({ receiverKey: RECEIVER_KEY })
        .expect(403);
      expect(res.body.code).toBe('gateway_required');
      expect(easyRecoverySession.create).not.toHaveBeenCalled();
    });

    it('refuses a low-order receiver key before it touches the database', async () => {
      const res = await asPublicKey(
        request(http()).post(BASE).send({ receiverKey: LOW_ORDER_KEY }),
      ).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(easyRecoverySession.create).not.toHaveBeenCalled();
    });

    it('refuses a field the contract does not name', async () => {
      const res = await asPublicKey(
        request(http())
          .post(BASE)
          .send({ receiverKey: RECEIVER_KEY, serverUrl: 'https://x' }),
      ).expect(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('refuses a malformed code as a 400 that costs no attempt', async () => {
      const id = await open();
      await offer(id).expect(200);

      const res = await claim(id, '4821').expect(400);

      expect(res.body.code).toBe('validation_failed');
      expect(rows.get(id).attempts).toBe(0);
    });
  });

  describe('the flow, as the wallet sees it', () => {
    it('open → offered → claimed, never returning a secret on a poll', async () => {
      const id = await open();
      expect((await poll(id).expect(200)).body).toEqual({
        status: 'open',
        expiresAt: expect.any(String),
      });

      expect((await offer(id).expect(200)).body).toEqual({
        status: 'offered',
      });
      const offered = await poll(id).expect(200);
      expect(offered.body.status).toBe('offered');
      expect(JSON.stringify(offered.body)).not.toContain(CIPHERTEXT);
      expect(JSON.stringify(offered.body)).not.toContain(RECEIVER_KEY);

      expect((await claim(id, CODE).expect(200)).body).toEqual({
        ciphertext: CIPHERTEXT,
      });
      expect((await poll(id).expect(200)).body.status).toBe('claimed');
      expect(rows.get(id).ciphertext).toBeNull();
      expect(rows.get(id).codeHash).toBeNull();
    });

    it('answers 409 easy_recovery_not_offered to a claim before the offer', async () => {
      const id = await open();
      const res = await claim(id, CODE).expect(409);
      expect(res.body.code).toBe('easy_recovery_not_offered');
    });

    it('answers 409 easy_recovery_already_offered to a second offer', async () => {
      const id = await open();
      await offer(id).expect(200);
      const res = await offer(id).expect(409);
      expect(res.body.code).toBe('easy_recovery_already_offered');
    });

    it('answers a wrong code with 422 and details.attemptsLeft', async () => {
      const id = await open();
      await offer(id).expect(200);

      const res = await claim(id, '11111').expect(422);

      expect(res.body).toEqual({
        statusCode: 422,
        code: 'easy_recovery_code_invalid',
        error: 'Unprocessable Entity',
        message: 'That code is not the one shown on the other device.',
        details: { attemptsLeft: 4 },
        path: `${BASE}/${id}/claim`,
        timestamp: expect.any(String),
      });
    });

    it('answers the fifth wrong code with 410 easy_recovery_burned, then 404 everywhere', async () => {
      const id = await open();
      await offer(id).expect(200);
      for (const left of [4, 3, 2, 1]) {
        const res = await claim(id, '11111').expect(422);
        expect(res.body.details).toEqual({ attemptsLeft: left });
      }

      const burned = await claim(id, '11111').expect(410);
      expect(burned.body).toEqual({
        statusCode: 410,
        code: 'easy_recovery_burned',
        error: 'Gone',
        message:
          'Too many wrong codes: this recovery session was deleted. Start again on the new device.',
        path: `${BASE}/${id}/claim`,
        timestamp: expect.any(String),
      });

      const gone = await poll(id).expect(404);
      expect(gone.body.code).toBe('easy_recovery_not_found');
      expect((await claim(id, CODE).expect(404)).body.code).toBe(
        'easy_recovery_not_found',
      );
    });

    it('answers 404 easy_recovery_not_found for an expired session', async () => {
      const id = await open();
      await offer(id).expect(200);
      rows.get(id).expiresAt = new Date(Date.now() - 1);

      for (const res of [
        await poll(id),
        await claim(id, CODE),
        await offer(id),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('easy_recovery_not_found');
      }
    });
  });
});
