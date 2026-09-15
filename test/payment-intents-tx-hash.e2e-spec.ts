import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The PaymentIntent unique keys `prisma/schema.prisma` declares: every `@unique`
 * field and every `@@unique([...])` list.
 *
 * Read from the schema rather than restated in the mock, because this suite is
 * about what the index allows. A constraint written into the mock by hand would
 * agree with whatever the tests expect, whatever the schema says.
 */
function paymentIntentUniqueKeys(): string[][] {
  const schema = readFileSync(
    join(__dirname, '..', 'prisma', 'schema.prisma'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const model = /^model PaymentIntent \{\n([\s\S]*?)^\}/m.exec(schema);
  if (!model) {
    throw new Error('model PaymentIntent not found in prisma/schema.prisma');
  }
  const keys: string[][] = [];
  for (const raw of model[1].split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const compound = /^@@unique\(\[([^\]]+)\]/.exec(line);
    if (compound) {
      keys.push(compound[1].split(',').map((field) => field.trim()));
      continue;
    }
    const field = /^(\w+)\s.*@unique\b/.exec(line);
    if (field) {
      keys.push([field[1]]);
    }
  }
  return keys;
}

/**
 * A unique violation shaped the way `@prisma/adapter-pg` reports one: the index
 * under `driverAdapterError`, and no `meta.target`.
 */
function uniqueViolation(key: string[]): Error {
  return Object.assign(
    new Error(`Unique constraint failed on ${key.join(', ')}`),
    {
      code: 'P2002',
      meta: {
        modelName: 'PaymentIntent',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index: `payment_intent_${key.join('_')}_key` },
            table: 'payment_intent',
          },
        },
      },
    },
  );
}

/**
 * `txHash` at the HTTP boundary: the format it must have, and whose intents it
 * must be unique among.
 *
 * It was unique across every tenant, and PATCH stores a reported hash
 * unverified, so one tenant could write another tenant's transaction hash onto
 * an intent of its own. The other tenant's settlement then failed on the index:
 * validate answered 500, the observer retried on every tick, and the intent
 * expired although it was paid.
 *
 * Prisma and Horizon are mocked; the mock enforces the unique keys the schema
 * declares (see {@link paymentIntentUniqueKeys}).
 */
describe('Payment intent txHash (e2e)', () => {
  let app: INestApplication;

  const UNIQUE_KEYS = paymentIntentUniqueKeys();
  const store = new Map<string, any>();
  const transitions: any[] = [];
  let seq = 0;
  let memoSeq = 7000;
  const nextMemo = () => String(++memoSeq);

  const tenantA = 'cosmos_tenant_a';
  const tenantB = 'cosmos_tenant_b';
  const destinationA = Keypair.random().publicKey();
  const destinationB = Keypair.random().publicKey();
  const payer = Keypair.random().publicKey();

  /** Transactions Horizon knows, by hash: the memo each carries and whom it pays. */
  const onChain = new Map<string, { memo: string; to: string }>();

  const consumerIdOf = (username: string) => `c_${username}`;

  /** Refuses `row` when another row holds one of its unique keys. NULLs never collide, as in PostgreSQL. */
  function assertUnique(row: Record<string, unknown>): void {
    for (const key of UNIQUE_KEYS) {
      if (key.some((field) => row[field] == null)) continue;
      const taken = [...store.values()].some(
        (other) =>
          other.id !== row.id &&
          key.every((field) => other[field] === row[field]),
      );
      if (taken) throw uniqueViolation(key);
    }
  }

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
      upsert: jest.fn(async ({ where }: any) => ({
        id: consumerIdOf(where.apisixUsername),
        apisixUsername: where.apisixUsername,
      })),
    },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'cust_1' }),
    },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    webhookEmittedEvent: { create: jest.fn().mockResolvedValue({}) },
    webhookDelivery: {
      create: jest.fn().mockResolvedValue({ id: 'whd_1' }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },

    paymentIntent: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pi_${++seq}`,
          source: null,
          txHash: null,
          reference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        assertUnique(row);
        store.set(row.id, row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = store.get(where.id);
        const owner = where.consumer?.apisixUsername;
        return row && (!owner || row.consumerId === consumerIdOf(owner))
          ? row
          : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return store.get(where.id) ?? null;
        const { consumerId, memo } = where.consumerId_memo;
        return (
          [...store.values()].find(
            (row) => row.consumerId === consumerId && row.memo === memo,
          ) ?? null
        );
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = store.get(where.id);
        if (!row) throw new Error('not found');
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...store.get(where.id), ...data, updatedAt: new Date() };
        assertUnique(row);
        store.set(where.id, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row || (where.status && row.status !== where.status)) {
          return { count: 0 };
        }
        const next = { ...row, ...data, updatedAt: new Date() };
        assertUnique(next);
        store.set(where.id, next);
        return { count: 1 };
      }),
    },
    paymentIntentTransition: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `tr_${transitions.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        transitions.push(row);
        return row;
      }),
    },
  };

  beforeAll(async () => {
    // A known hash is a successful transaction closed just now, carrying its
    // memo and paying its destination 10 XLM; anything else is a 404.
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: (hash: string) => ({
        call: async () => {
          const tx = onChain.get(hash);
          if (!tx) {
            throw Object.assign(new Error('Not Found'), {
              response: { status: 404 },
            });
          }
          return {
            successful: true,
            memo_type: 'id',
            memo: tx.memo,
            created_at: new Date().toISOString(),
          };
        },
      }),
    } as never);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: (hash: string) => ({
        call: async () => ({
          records: [
            {
              type: 'payment',
              asset_type: 'native',
              from: payer,
              to: onChain.get(hash)?.to,
              amount: '10.0000000',
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
  const as = (username: string, r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret-topsecret-topsecret-topsecret')
      .set('x-consumer-username', username)
      .set('x-consumer-permissions', 'payments:read,payments:write');

  async function createIntent(
    username: string,
    destination: string,
  ): Promise<{ id: string; memo: string }> {
    const res = await as(
      username,
      request(http())
        .post(`${route}/pay`)
        .send({ destination, amount: '10', memo: nextMemo() }),
    ).expect(201);
    return res.body;
  }

  const patchTxHash = (username: string, id: string, txHash: string) =>
    as(username, request(http()).patch(`${route}/${id}`).send({ txHash }));

  const validate = (username: string, id: string, txHash: string) =>
    as(
      username,
      request(http()).post(`${route}/${id}/validate`).send({ txHash }),
    );

  it('enforces the unique keys the schema declares', () => {
    // Without this the rest of the suite could pass against a mock that
    // enforces nothing at all.
    expect(UNIQUE_KEYS).toContainEqual(['consumerId', 'memo']);
  });

  describe('format', () => {
    it.each([
      ['shorter than 64 characters', 'abc123'],
      ['longer than 64 characters', 'a'.repeat(65)],
      ['not hexadecimal', 'g'.repeat(64)],
    ])('refuses a txHash %s (400)', async (_label, txHash) => {
      const intent = await createIntent(tenantA, destinationA);

      await patchTxHash(tenantA, intent.id, txHash).expect(400);

      expect(store.get(intent.id).txHash).toBeNull();
    });

    it('stores a hash reported in uppercase as lowercase', async () => {
      const intent = await createIntent(tenantA, destinationA);

      const res = await patchTxHash(tenantA, intent.id, 'AB'.repeat(32)).expect(
        200,
      );

      expect(res.body.txHash).toBe('ab'.repeat(32));
    });
  });

  describe('uniqueness', () => {
    it("still settles tenant B's intent when tenant A reported B's transaction hash first", async () => {
      const victim = await createIntent(tenantB, destinationB);
      const attacker = await createIntent(tenantA, destinationA);
      const hash = 'e'.repeat(64);
      onChain.set(hash, { memo: victim.memo, to: destinationB });

      // Tenant A parks the victim's hash on its own intent. A PATCH verifies
      // nothing, so this is always accepted.
      await patchTxHash(tenantA, attacker.id, hash).expect(200);

      const res = await validate(tenantB, victim.id, hash).expect(200);

      expect(res.body.valid).toBe(true);
      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.paymentIntent.txHash).toBe(hash);
    });

    it("refuses a hash already on another of the same tenant's intents (409)", async () => {
      const first = await createIntent(tenantA, destinationA);
      const second = await createIntent(tenantA, destinationA);
      const hash = 'f'.repeat(64);
      await patchTxHash(tenantA, first.id, hash).expect(200);

      const res = await patchTxHash(tenantA, second.id, hash).expect(409);

      expect(res.body.code).toBe('idempotency_conflict');
      expect(res.body.message).not.toContain(first.id);
      expect(store.get(second.id).txHash).toBeNull();
    });

    it("answers a settlement that collides with the tenant's own report with 409, not 500", async () => {
      const decoy = await createIntent(tenantB, destinationB);
      const paid = await createIntent(tenantB, destinationB);
      const hash = `${'0'.repeat(63)}1`;
      onChain.set(hash, { memo: paid.memo, to: destinationB });
      await patchTxHash(tenantB, decoy.id, hash).expect(200);

      const res = await validate(tenantB, paid.id, hash).expect(409);

      expect(res.body.code).toBe('idempotency_conflict');
      expect(store.get(paid.id).status).toBe('PENDING');
    });
  });
});
