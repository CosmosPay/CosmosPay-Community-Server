import { createHash } from 'node:crypto';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';

/**
 * The preinstalled Sub Rosa plugin (`plugins/sub-rosa/`) through the HTTP
 * routes, the runtime, the isolate and the storage service, with Prisma
 * replaced by an in-memory table that applies `compareAndSet`'s conditions the
 * way Postgres does. The plugin's own rules are `src/plugins/sub-rosa-plugin.spec.ts`;
 * this is that they hold end to end, under the support signature.
 */
process.env.PLUGINS_ENABLED = 'sub-rosa';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const USERNAME = 'cosmos_sub_rosa_e2e';
const RFQ_ID = '86b82f3d-64d8-4b50-9b28-0d43f2f4500f';
const TESTNET_CORE_V2 =
  'CCOVGOQQZJKZ2R55GRWBLTJTGBAMSHXZVN3ICPG3WRVMLMM6RHISC5OV';
const SCHEMA_REF =
  'b84a413c18205d4e45e80eff8ef29d322fbac1fd2f634b3fca9d9740c6176f6a';
const PROVIDER = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const TX = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

describe('Sub Rosa plugin through Cosmos Pay HTTP (e2e)', () => {
  let app: INestApplication;
  const installations = new Map<string, any>();
  const records = new Map<string, any>();
  const now = new Date('2026-11-03T12:00:00.000Z');
  const intent = (id: string, destination: string) => ({
    id,
    consumerId: 'consumer-1',
    kind: 'PAY',
    status: 'PENDING',
    chain: 'stellar',
    network: 'testnet',
    source: null,
    destination,
    amount: '2500',
    asset: 'USDC',
    assetIssuer: null,
    memo: '42',
    xdr: null,
    uri: `web+stellar:pay?destination=${destination}&amount=2500&memo=42`,
    txHash: null,
    reference: 'sub-rosa-rfq',
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const intents = [intent('pi_provider', PROVIDER), intent('pi_other', OTHER)];
  const storageKey = (where: any) =>
    `${where.installationId}:${where.collection}:${where.key}`;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn(() => Promise.resolve([{ count: 1 }])),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'request-1' }) },
    consumer: {
      upsert: jest.fn().mockImplementation(({ create }: any) =>
        Promise.resolve({
          id: 'consumer-1',
          apisixUsername: create.apisixUsername,
          credentialId: null,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    },
    pluginInstallation: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.consumer?.apisixUsername === USERNAME
              ? (installations.get(where.pluginSlug) ?? null)
              : null,
          ),
        ),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockImplementation(({ create, update }: any) => {
        const existing = installations.get(create.pluginSlug);
        const row = {
          id: 'installation-1',
          consumerId: create.consumerId,
          pluginSlug: create.pluginSlug,
          ...(existing ? update : create),
          createdAt: now,
          updatedAt: now,
        };
        installations.set(create.pluginSlug, row);
        return Promise.resolve(row);
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    pluginRecord: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        const row = records.get(
          storageKey(where.installationId_collection_key),
        );
        return Promise.resolve(row ? { key: row.key, value: row.value } : null);
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        const row = records.get(storageKey(where));
        const matches =
          row &&
          (where.value === undefined ||
            sameJson(row.value, where.value.equals));
        if (!matches) return Promise.resolve({ count: 0 });
        records.set(storageKey(where), { ...row, value: data.value });
        return Promise.resolve({ count: 1 });
      }),
      create: jest.fn().mockImplementation(({ data }: any) => {
        if (records.has(storageKey(data))) {
          return Promise.reject(
            Object.assign(new Error('dup'), { code: 'P2002' }),
          );
        }
        records.set(storageKey(data), { ...data, updatedAt: now });
        return Promise.resolve(data);
      }),
      update: jest.fn(),
      count: jest.fn().mockImplementation(() => Promise.resolve(records.size)),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    paymentIntent: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.consumer?.apisixUsername === USERNAME
              ? (intents.find((i) => i.id === where.id) ?? null)
              : null,
          ),
        ),
    },
  };

  beforeAll(async () => {
    const [{ AppModule }, { PrismaService }] = await Promise.all([
      import('@/app.module'),
      import('@/prisma/prisma.service'),
    ]);
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

  const asTenant = (
    test: request.Test,
    permissions = 'plugins:read,plugins:write',
  ) =>
    test
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', USERNAME)
      .set('x-consumer-role', 'user')
      .set('x-consumer-permissions', permissions);
  const command = (action: string, input: Record<string, unknown>) =>
    asTenant(
      request(app.getHttpServer()).post(
        `/v1/plugins/sub-rosa/commands/${action}`,
      ),
    ).send({ input });

  it('runs the private RFQ from creation to the linked payment', async () => {
    const plugin = await asTenant(
      request(app.getHttpServer()).get('/v1/plugins/sub-rosa'),
      'plugins:read',
    ).expect(200);
    expect(plugin.body).toMatchObject({
      version: '0.2.0',
      capabilities: ['payment_intents:read'],
      egress: [],
      commands: [
        'create-rfq',
        'attach-sub-rosa-round',
        'record-result',
        'attach-payment-intent',
      ],
    });

    await asTenant(
      request(app.getHttpServer()).put('/v1/plugins/sub-rosa/installation'),
    )
      .send({ grantCapabilities: ['payment_intents:read'] })
      .expect(200);

    const commitDeadline = Math.floor(Date.now() / 1000) + 3600;
    const definition = {
      commitDeadline,
      description: null,
      revealDeadline: commitDeadline + 600,
      rfqId: RFQ_ID,
      schema: 'cosmos-pay:sub-rosa-rfq:v1',
      title: 'Testnet private RFQ',
    };
    const itemRef = createHash('sha256')
      .update(JSON.stringify(definition))
      .digest('hex');
    const rfq = {
      rfqId: RFQ_ID,
      title: definition.title,
      itemRef,
      commitDeadline,
      revealDeadline: definition.revealDeadline,
    };

    const forged = await command('create-rfq', {
      ...rfq,
      itemRef: TX(7),
    }).expect(400);
    expect(forged.body.code).toBe('plugin_rejected');
    await command('create-rfq', rfq).expect(200);
    const twice = await command('create-rfq', rfq).expect(400);
    expect(twice.body.message).toMatch(/already exists/);

    const round = {
      rfqId: RFQ_ID,
      network: 'testnet',
      contractId: TESTNET_CORE_V2,
      roundId: '42',
      protocolVersion: 'core-v2',
      mode: 'ReceiptOnly',
      schemaRef: SCHEMA_REF,
      itemRef,
      revealRound: 123456,
      createTxHash: TX(1),
    };
    await command('attach-sub-rosa-round', {
      ...round,
      contractId: `C${'D'.repeat(55)}`,
    }).expect(400);
    await command('attach-sub-rosa-round', round).expect(200);

    const result = {
      rfqId: RFQ_ID,
      selectedProviderAddress: PROVIDER,
      receiptHash: TX(9),
      receiptVersion: 2,
      clientVerified: true,
      openRevealTxHash: TX(2),
      revealTxHash: TX(3),
      clearTxHash: TX(4),
    };
    const early = await command('record-result', result).expect(400);
    expect(early.body.message).toMatch(/after the commit deadline/);

    // The commit phase closes.
    const key = `installation-1:rfqs:${RFQ_ID}`;
    const row = records.get(key);
    records.set(key, {
      ...row,
      value: {
        ...row.value,
        commitDeadline: Math.floor(Date.now() / 1000) - 1,
      },
    });
    await command('record-result', result).expect(200);

    const elsewhere = await command('attach-payment-intent', {
      rfqId: RFQ_ID,
      paymentIntentId: 'pi_other',
    }).expect(400);
    expect(elsewhere.body.message).toMatch(/must pay the selected provider/);
    await command('attach-payment-intent', {
      rfqId: RFQ_ID,
      paymentIntentId: 'pi_provider',
    }).expect(200);

    const read = await asTenant(
      request(app.getHttpServer()).post('/v1/plugins/sub-rosa/queries/get-rfq'),
      'plugins:read',
    )
      .send({ input: { rfqId: RFQ_ID } })
      .expect(200);
    expect(read.body.output).toMatchObject({
      rfq: {
        status: 'provider-selected',
        paymentIntentId: 'pi_provider',
        subRosa: { contractId: TESTNET_CORE_V2, roundId: '42' },
        selection: { selectedProviderAddress: PROVIDER, receiptVersion: 2 },
      },
      paymentIntent: { id: 'pi_provider', destination: PROVIDER },
    });
    // The read is the projection: nothing a wallet signs.
    expect(read.body.output.paymentIntent).not.toHaveProperty('xdr');
    expect(read.body.output.paymentIntent).not.toHaveProperty('consumerId');
  });

  it('does not let a read key run a command', async () => {
    await asTenant(
      request(app.getHttpServer()).post(
        '/v1/plugins/sub-rosa/commands/create-rfq',
      ),
      'plugins:read',
    )
      .send({ input: {} })
      .expect(403);
  });
});
