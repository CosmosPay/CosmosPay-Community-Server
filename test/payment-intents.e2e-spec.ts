import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Account, Horizon, Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { rivalsOf } from './payment-intent-rivals';
import {
  CHECKOUT_THEMES,
  PAYMENT_INTENT_BUILD_RATE_LIMIT,
} from '@/payment-intents/payment-intents.constants';

/**
 * Full CRUD for Stellar payment intents behind the APISIX gate. Horizon and
 * Prisma are mocked so no real network or database is required; the Prisma mock
 * keeps a tiny in-memory store so create→read→update→delete stays consistent.
 */
describe('Payment intents CRUD (e2e)', () => {
  let app: INestApplication;

  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();

  // Minimal in-memory store keyed by id.
  const store = new Map<string, any>();
  const transitions: any[] = [];
  const settlements = new Set<string>();
  let seq = 0;

  const rateLimitCounters = new Map<string, number>();

  /** One local consumer row per gateway username, as the resolver upserts it. */
  const consumerIdOf = (username: string) => `c_${username}`;

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock);
      return Promise.all(arg);
    },
    consumer: {
      upsert: jest.fn(({ where }: any) =>
        Promise.resolve({
          id: consumerIdOf(where.apisixUsername),
          apisixUsername: where.apisixUsername,
        }),
      ),
    },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'cust_1' }),
    },
    // The webhook dispatcher reacts to emitted events; no endpoints registered here.
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    // Terminal payment-intent events now go through WebhookTerminalEmitter,
    // which claims a dedup row and writes the delivery rows in one
    // transaction before touching the bus. With no endpoints registered the
    // delivery create is never reached, but the claim always is.
    webhookEmittedEvent: { create: jest.fn().mockResolvedValue({}) },
    webhookDelivery: {
      create: jest.fn().mockResolvedValue({ id: 'whd_1' }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },
    /**
     * The rate limiter's counter. Keyed by bucket alone, not by window: a
     * one-minute window would now and then roll over in the middle of a test,
     * and the window arithmetic is rate-limit.service.spec's to pin.
     */
    $queryRaw: jest.fn((_sql: unknown, key: string) => {
      const next = (rateLimitCounters.get(key) ?? 0) + 1;
      rateLimitCounters.set(key, next);
      return Promise.resolve([{ count: next }]);
    }),

    paymentIntent: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `pi_${++seq}`,
          txHash: null,
          reference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.set(row.id, row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn((args: any) =>
        Promise.resolve(rivalsOf(store.values(), args) ?? [...store.values()]),
      ),
      count: jest.fn(() => Promise.resolve(store.size)),
      // Scoped like the real query: another consumer's row is not found.
      findFirst: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        const owner = where.consumer?.apisixUsername;
        return Promise.resolve(
          row && (!owner || row.consumerId === consumerIdOf(owner))
            ? row
            : null,
        );
      }),
      findUnique: jest.fn(({ where }: any) => {
        if (where?.id) {
          return Promise.resolve(store.get(where.id) ?? null);
        }
        const memo = where?.consumerId_memo?.memo;
        const found = [...store.values()].find((r) => r.memo === memo);
        return Promise.resolve(found ?? null);
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        if (!row) return Promise.reject(new Error('not found'));
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = { ...store.get(where.id), ...data, updatedAt: new Date() };
        store.set(where.id, row);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row || (where.status && row.status !== where.status)) {
          return Promise.resolve({ count: 0 });
        }
        const next = { ...row, ...data, updatedAt: new Date() };
        store.set(where.id, next);
        return Promise.resolve({ count: 1 });
      }),
      // DELETE is a compare-and-swap on the status it read.
      deleteMany: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        if (!row || (where.status && row.status !== where.status)) {
          return Promise.resolve({ count: 0 });
        }
        store.delete(where.id);
        return Promise.resolve({ count: 1 });
      }),
    },
    // The settled hash's claim: one per (chain, network, txHash).
    paymentSettlement: {
      create: jest.fn(({ data }: any) => {
        const key = `${data.chain}|${data.network}|${data.txHash}`;
        if (settlements.has(key)) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        settlements.add(key);
        return Promise.resolve(data);
      }),
    },
    paymentIntentTransition: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `tr_${transitions.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        transitions.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          transitions.filter((t) => t.intentId === where.intentId),
        ),
      ),
    },
  };

  beforeAll(async () => {
    jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new Account(source, '123456789') as never);

    // Mock the verification path: a successful tx paying `destination` 25.5 XLM
    // with the matching id memo, closed after the intent it is checked against
    // (the verifier refuses a transaction that predates the intent).
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => ({
          successful: true,
          memo_type: 'id',
          memo: '123456789',
          created_at: new Date().toISOString(),
        }),
      }),
    } as never);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: () => ({
        call: async () => ({
          records: [
            {
              type: 'payment',
              asset_type: 'native',
              to: destination,
              amount: '25.5000000',
            },
          ],
        }),
      }),
    } as never);

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

  const http = () => app.getHttpServer();
  const route = '/v1/payment-intents';
  const txRoute = `${route}/tx`;
  const payRoute = `${route}/pay`;
  const gwAs = (username: string) => (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret-topsecret-topsecret-topsecret')
      .set('x-consumer-username', username)
      .set('x-consumer-permissions', 'payments:read,payments:write');
  const gw = gwAs('cosmos_u1');

  let createdId: string;

  it('rejects creation without the gateway secret (403)', () =>
    request(http())
      .post(txRoute)
      .send({ source, destination, amount: '25.5' })
      .expect(403));

  it('rejects an invalid Stellar address (400)', () =>
    gw(
      request(http())
        .post(txRoute)
        .send({ source: 'bad', destination, amount: '1' }),
    ).expect(400));

  it('creates a TX intent (201) with xdr + tx URI', async () => {
    const res = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '25.5', memo: '123456789' }),
    ).expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('PENDING');
    expect(res.body.network).toBe('testnet');
    expect(res.body.kind).toBe('TX');
    expect(res.body.memo).toBe('123456789');
    expect(res.body.uri).toContain('web+stellar:tx?xdr=');
    expect(res.body.xdr).toBeTruthy();
    expect(res.body.qr).toContain('data:image/png;base64,');
    createdId = res.body.id;
  });

  it('auto-generates a numeric MEMO_ID when none is provided', async () => {
    const res = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '1.5' }),
    ).expect(201);
    expect(res.body.memo).toMatch(/^\d+$/);
  });

  it('is idempotent per (consumer, memo) — an identical retry returns the same intent', async () => {
    const memo = '5550001';
    const body = { source, destination, amount: '2', memo };
    const first = await gw(request(http()).post(txRoute).send(body)).expect(
      201,
    );
    const second = await gw(request(http()).post(txRoute).send(body)).expect(
      201,
    );
    expect(second.body.id).toBe(first.body.id);

    // A different payment under the same memo is not a retry.
    const changed = await gw(
      request(http())
        .post(txRoute)
        .send({ ...body, amount: '999' }),
    ).expect(409);
    expect(changed.body.code).toBe('idempotency_conflict');
  });

  it('refuses a memo already taken by another payment (409) without revealing it', async () => {
    // Under the shared public key every anonymous caller is one consumer: the
    // first request stands in for an attacker claiming the memo with their own
    // destination, the second for the next user who picks it.
    const memo = '5550002';
    const attacker = Keypair.random().publicKey();
    await gw(
      request(http())
        .post(payRoute)
        .send({ destination: attacker, amount: '2', memo }),
    ).expect(201);

    const res = await gw(
      request(http()).post(payRoute).send({ destination, amount: '2', memo }),
    ).expect(409);

    expect(res.body.code).toBe('idempotency_conflict');
    expect(res.body.id).toBeUndefined();
    expect(res.body.uri).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(attacker);
  });

  it('network follows the API key type (prod env → public)', async () => {
    const res = await gw(
      request(http())
        .post(txRoute)
        .set('x-consumer-env', 'prod')
        .send({ source, destination, amount: '3', memo: '424242' }),
    ).expect(201);
    expect(res.body.network).toBe('public');
  });

  it('creates a PAY intent (201) with pay URI, no xdr', async () => {
    const res = await gw(
      request(http())
        .post(payRoute)
        .send({ destination, amount: '10', memo: '777' }),
    ).expect(201);
    expect(res.body.kind).toBe('PAY');
    expect(res.body.xdr).toBeNull();
    expect(res.body.uri).toContain('web+stellar:pay?');
    expect(res.body.uri).toContain(`destination=${destination}`);
    expect(res.body.uri).toContain('memo_type=MEMO_ID');
    expect(res.body.qr).toContain('data:image/png;base64,');
  });

  it('PAY defaults to native XLM when no asset is given', async () => {
    const res = await gw(
      request(http()).post(payRoute).send({ destination, amount: '5' }),
    ).expect(201);
    expect(res.body.asset).toBe('native');
  });

  it('rejects a non-native asset without an issuer (400)', () =>
    gw(
      request(http())
        .post(payRoute)
        .send({ destination, amount: '5', assetCode: 'USDC' }),
    ).expect(400));

  it('rejects a TX without amount (400)', () =>
    gw(request(http()).post(txRoute).send({ source, destination })).expect(
      400,
    ));

  it('lists the consumer payment intents (200)', async () => {
    const res = await gw(request(http()).get(route)).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('gets one by id (200)', async () => {
    const res = await gw(request(http()).get(`${route}/${createdId}`)).expect(
      200,
    );
    expect(res.body.id).toBe(createdId);
    expect(res.body.qr).toContain('data:image/png;base64,');
  });

  it('updates status + txHash (200)', async () => {
    const res = await gw(
      request(http())
        .patch(`${route}/${createdId}`)
        .send({ status: 'SUBMITTED', txHash: 'c'.repeat(64) }),
    ).expect(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.txHash).toBe('c'.repeat(64));
  });

  it('404s an update on an unknown id', () =>
    gw(
      request(http()).patch(`${route}/nope`).send({ status: 'FAILED' }),
    ).expect(404));

  it('validates a submitted tx and finalizes the intent (SUCCEEDED)', async () => {
    const res = await gw(
      request(http())
        .post(`${route}/${createdId}/validate`)
        .send({ txHash: 'a'.repeat(64) }),
      // 200, not 201: validate reconciles an existing intent, it creates nothing.
    ).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.paymentIntent.status).toBe('SUCCEEDED');
    expect(res.body.paymentIntent.txHash).toBe('a'.repeat(64));
  });

  it('refuses to rewrite the txHash of a SUCCEEDED intent (400)', async () => {
    const res = await gw(
      request(http())
        .patch(`${route}/${createdId}`)
        .send({ txHash: 'b'.repeat(64) }),
    ).expect(400);
    expect(res.body.code).toBe('invalid_state_transition');

    const read = await gw(request(http()).get(`${route}/${createdId}`)).expect(
      200,
    );
    expect(read.body.txHash).toBe('a'.repeat(64));
  });

  it('rejects validation with a malformed txHash (400)', () =>
    gw(
      request(http())
        .post(`${route}/${createdId}/validate`)
        .send({ txHash: 'short' }),
    ).expect(400));

  it('deletes an unpaid intent (200) and then 404s on read', async () => {
    const created = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '1', memo: '888001' }),
    ).expect(201);
    await gw(request(http()).delete(`${route}/${created.body.id}`)).expect(200);
    await gw(request(http()).get(`${route}/${created.body.id}`)).expect(404);
  });

  it('rejects deleting a SUCCEEDED (paid) intent (400)', async () => {
    await gw(request(http()).delete(`${route}/${createdId}`)).expect(400);
  });

  describe('the checkout design', () => {
    const publicRead = (id: string) =>
      request(http()).get(`/v1/payment-links/${id}`).expect(200);

    it.each(CHECKOUT_THEMES)(
      'creates a PAY intent in the %s design, and every read answers it',
      async (theme) => {
        const created = await gw(
          request(http())
            .post(payRoute)
            .send({ destination, amount: '4', checkoutTheme: theme }),
        ).expect(201);
        expect(created.body.checkoutTheme).toBe(theme);
        expect(store.get(created.body.id).checkoutTheme).toBe(theme);

        const read = await gw(
          request(http()).get(`${route}/${created.body.id}`),
        ).expect(200);
        expect(read.body.checkoutTheme).toBe(theme);
        expect((await publicRead(created.body.id)).body.checkoutTheme).toBe(
          theme,
        );
      },
    );

    it('creates a TX intent in the chosen design', async () => {
      const res = await gw(
        request(http())
          .post(txRoute)
          .send({ source, destination, amount: '4', checkoutTheme: 'ticket' }),
      ).expect(201);
      expect(res.body.checkoutTheme).toBe('ticket');
      expect(store.get(res.body.id).checkoutTheme).toBe('ticket');
    });

    it('stores none when the create names none, and answers classic everywhere', async () => {
      const res = await gw(
        request(http()).post(payRoute).send({ destination, amount: '4' }),
      ).expect(201);
      expect(res.body.checkoutTheme).toBe('classic');
      expect(store.get(res.body.id).checkoutTheme).toBeNull();

      const list = await gw(request(http()).get(route)).expect(200);
      const listed = list.body.data.find(
        (row: { id: string }) => row.id === res.body.id,
      );
      expect(listed.checkoutTheme).toBe('classic');
      expect((await publicRead(res.body.id)).body.checkoutTheme).toBe(
        'classic',
      );
    });

    it.each([
      ['TX', () => ({ source, destination, amount: '4' })],
      ['PAY', () => ({ destination, amount: '4' })],
    ])(
      'refuses a %s create naming a design it does not draw (400)',
      async (kind, body) => {
        const before = store.size;
        const res = await gw(
          request(http())
            .post(kind === 'TX' ? txRoute : payRoute)
            .send({ ...body(), checkoutTheme: 'neon' }),
        ).expect(400);
        expect(JSON.stringify(res.body)).toContain('checkoutTheme');
        expect(store.size).toBe(before);
      },
    );

    it('changes the design of a settled intent, and nothing else (200)', async () => {
      // `createdId` is SUCCEEDED by now; the design is cosmetic, so a final
      // status does not freeze it.
      const before = { ...store.get(createdId) };
      const res = await gw(
        request(http())
          .patch(`${route}/${createdId}`)
          .send({ checkoutTheme: 'split' }),
      ).expect(200);

      expect(res.body.checkoutTheme).toBe('split');
      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.txHash).toBe(before.txHash);
      expect((await publicRead(createdId)).body.checkoutTheme).toBe('split');
    });

    it('changes the design alongside a status change (200)', async () => {
      const created = await gw(
        request(http()).post(payRoute).send({ destination, amount: '4' }),
      ).expect(201);

      const res = await gw(
        request(http())
          .patch(`${route}/${created.body.id}`)
          .send({ status: 'CANCELLED', checkoutTheme: 'card' }),
      ).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.checkoutTheme).toBe('card');
    });

    it('refuses a design it does not draw (400), leaving the stored one', async () => {
      const res = await gw(
        request(http())
          .patch(`${route}/${createdId}`)
          .send({ checkoutTheme: 'Classic' }),
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain('checkoutTheme');
      expect(store.get(createdId).checkoutTheme).toBe('split');
    });

    it("answers another consumer's intent as not found (404), not forbidden", async () => {
      const res = await gwAs('cosmos_u2')(
        request(http())
          .patch(`${route}/${createdId}`)
          .send({ checkoutTheme: 'ticket' }),
      ).expect(404);
      expect(res.body.message).toBe(`Payment intent ${createdId} not found`);
      expect(store.get(createdId).checkoutTheme).toBe('split');
    });
  });

  describe('the rate limit on the builders', () => {
    const { limit } = PAYMENT_INTENT_BUILD_RATE_LIMIT;

    // The tests above already spent some of the bucket; this one counts.
    beforeAll(() => rateLimitCounters.clear());

    const buildTx = (memo: string) =>
      gw(
        request(http())
          .post(txRoute)
          .send({ source, destination, amount: '1', memo }),
      );

    it('refuses a caller past its budget (429), counting both builders in it', async () => {
      // Both routes take the shared public API key, so every anonymous wallet
      // is one consumer and the client address is all that separates them. One
      // bucket for the two, or a loop would alternate them and take both.
      for (let i = 0; i < limit; i++) {
        await buildTx(String(920000 + i)).expect(201);
      }

      const refused = await gw(
        request(http())
          .post(payRoute)
          .send({ destination, amount: '1', memo: '929999' }),
      ).expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(refused.headers['ratelimit-limit']).toBe(String(limit));
      expect(refused.headers['ratelimit-remaining']).toBe('0');
      // Thirty sequential builds, each with its QR: past the 5 s default.
    }, 30_000);
  });
});
