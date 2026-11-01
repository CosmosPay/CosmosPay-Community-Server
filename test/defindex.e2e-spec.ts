import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Account,
  Address,
  Asset,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { DefindexClient } from '@/native-plugins/defindex/defindex.client';
import { PrismaService } from '@/prisma/prisma.service';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7));

/** Boots the app the way main.ts does, with these providers replaced. */
async function boot(
  overrides: [provider: unknown, value: unknown][],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const [provider, value] of overrides) {
    builder = builder.overrideProvider(provider).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
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
  return app;
}

/** An ordinary API key of `username` (a dev key: testnet). */
const asTenant = (r: request.Test, username = 'cosmos_alice') =>
  r
    .set('x-gateway-secret', SECRET)
    .set('x-consumer-username', username)
    .set('x-consumer-role', 'user')
    .set('x-consumer-env', 'dev')
    .set(
      'x-consumer-permissions',
      'liquidity:read,liquidity:write,swaps:read,swaps:write',
    );

/** The shared public key, with every scope a DeFindex route asks for. */
const asPublicKey = (r: request.Test) =>
  r
    .set('x-gateway-secret', SECRET)
    .set('x-consumer-username', 'cosmos_public')
    .set('x-consumer-role', 'public')
    .set('x-consumer-env', 'dev')
    .set(
      'x-consumer-permissions',
      'liquidity:read,liquidity:write,swaps:read,swaps:write',
    );

/**
 * The wiring in front of /v1/defindex, with no DeFindex key configured.
 *
 * The routes are served at /v1/defindex, the path the wallet calls. They were
 * once declared as `v1/defindex` under URI versioning and served at
 * /v1/v1/defindex, where no client looked. With no `DEFINDEX_API_KEY` a caller
 * that gets past the guards meets `503 misconfigured`, never an upstream call.
 */
describe('DeFindex guards (e2e)', () => {
  let app: INestApplication;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
  };

  beforeAll(async () => {
    app = await boot([[PrismaService, prismaMock]]);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();

  it('refuses a caller that did not come through the gateway', async () => {
    const res = await request(http()).get('/v1/defindex/vaults').expect(403);

    expect(res.body.code).toBe('gateway_required');
  });

  it('serves the vault list at /v1/defindex, and says DeFindex is off', async () => {
    const res = await asTenant(request(http()).get('/v1/defindex/vaults'));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('misconfigured');
  });

  it('does not serve the doubled /v1/v1/defindex prefix', async () => {
    await asTenant(request(http()).get('/v1/v1/defindex/vaults')).expect(404);
  });

  it('refuses a key without a liquidity or swaps scope', async () => {
    await request(http())
      .get('/v1/defindex/vaults')
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'user')
      .set('x-consumer-permissions', 'payments:read')
      .expect(403);
  });
});

// ── Envelopes, as DeFindex builds them ────────────────────────────────────

const holder = Keypair.random();
const CALLER = holder.publicKey();
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

const PASSPHRASES = { public: Networks.PUBLIC, testnet: Networks.TESTNET };
let sequence = 100n;

/** What DeFindex would build for a deposit: one `deposit` call on the vault. */
function depositEnvelope(
  network: keyof typeof PASSPHRASES,
  vault: string,
  caller: string,
  amounts: number[],
  invest: boolean,
): Transaction {
  const desired = amounts.map((a) => i128(BigInt(a)));
  return new TransactionBuilder(new Account(caller, String(sequence++)), {
    fee: '100000',
    networkPassphrase: PASSPHRASES[network],
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: vault,
        function: 'deposit',
        args: [
          xdr.ScVal.scvVec(desired),
          xdr.ScVal.scvVec(desired),
          new Address(caller).toScVal(),
          xdr.ScVal.scvBool(invest),
        ],
      }),
    )
    .setTimeout(300)
    .build();
}

function sign(envelope: string): string {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
  tx.sign(holder);
  return tx.toXDR();
}

/**
 * `POST /v1/defindex/submit` relays only what a build here handed out, with
 * DeFindex and the database replaced by in-memory doubles.
 *
 * It used to hand any signed XDR to DeFindex, which broadcast it: the service
 * was an open relay for arbitrary transactions under its own DeFindex key, and
 * the shared public key could reach it. Each case below is one way that relay
 * was open.
 */
describe('DeFindex submit binding (e2e)', () => {
  let app: INestApplication;

  type Row = Record<string, unknown> & { id: string; expiresAt: Date };
  const rows: Row[] = [];

  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (key === 'OR') {
        return (condition as Record<string, unknown>[]).some((branch) =>
          matches(row, branch),
        );
      }
      const value = row[key];
      if (condition instanceof Date) {
        return value instanceof Date && value.getTime() === condition.getTime();
      }
      if (condition && typeof condition === 'object') {
        const { lt, gte } = condition as { lt?: Date; gte?: Date };
        if (!(value instanceof Date)) return false;
        return (!lt || value < lt) && (!gte || value >= gte);
      }
      return value === condition;
    });

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    // Rate-limit counters: always the first request of its window.
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    consumer: {
      upsert: jest.fn(({ where }: { where: { apisixUsername: string } }) =>
        Promise.resolve({
          id: `local_${where.apisixUsername}`,
          apisixUsername: where.apisixUsername,
        }),
      ),
    },
    defindexTransaction: {
      upsert: jest.fn(({ create }: { create: Row }) => {
        const row: Row = {
          ...create,
          id: `dfx_${rows.length + 1}`,
          status: 'BUILT',
          claimedAt: null,
          submittedAt: null,
          result: null,
        };
        rows.push(row);
        return Promise.resolve({ ...row });
      }),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, where));
        return Promise.resolve(row ? { ...row } : null);
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        return Promise.resolve(row ? { ...row } : null);
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = rows.filter((r) => matches(r, where));
          for (const row of hit) Object.assign(row, data);
          return Promise.resolve({ count: hit.length });
        },
      ),
    },
  };

  const SEND_RESULT = {
    txHash: 'ab'.repeat(32),
    success: true,
    result: { type: 'vault_deposit', sharesMinted: '9950000' },
    ledger: 61234567,
  };

  const clientMock = {
    timeoutMs: 30_000,
    deposit: jest.fn(
      (
        network: keyof typeof PASSPHRASES,
        vault: string,
        params: { caller: string; amounts: number[]; invest: boolean },
      ) =>
        Promise.resolve({
          xdr: depositEnvelope(
            network,
            vault,
            params.caller,
            params.amounts,
            params.invest,
          ).toXDR(),
          simulationResponse: {},
          functionName: 'deposit',
          params: [],
        }),
    ),
    withdrawShares: jest.fn(),
    send: jest.fn().mockResolvedValue(SEND_RESULT),
  };

  beforeAll(async () => {
    app = await boot([
      [PrismaService, prismaMock],
      [DefindexClient, clientMock],
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rows.length = 0;
    clientMock.deposit.mockClear();
    clientMock.send.mockClear();
  });

  const http = () => app.getHttpServer();
  const DEPOSIT = `/v1/defindex/vaults/${VAULT}/deposit`;
  const SUBMIT = '/v1/defindex/submit';

  /** Builds a deposit as `username` and answers the unsigned XDR. */
  async function buildDeposit(username = 'cosmos_alice'): Promise<string> {
    const res = await asTenant(
      request(http())
        .post(DEPOSIT)
        .send({ amounts: ['10000000'], caller: CALLER }),
      username,
    ).expect(201);
    return res.body.xdr as string;
  }

  const submit = (xdrToSend: string, username = 'cosmos_alice') =>
    asTenant(request(http()).post(SUBMIT).send({ xdr: xdrToSend }), username);

  it('relays a signed copy of the transaction built for this key', async () => {
    const built = await buildDeposit();

    const res = await submit(sign(built)).expect(201);

    expect(res.body).toEqual(SEND_RESULT);
    expect(clientMock.send).toHaveBeenCalledTimes(1);
    expect(clientMock.send).toHaveBeenCalledWith('testnet', sign(built));
  });

  it('answers a replay with the first result and never resubmits', async () => {
    const signed = sign(await buildDeposit());
    const first = await submit(signed).expect(201);
    clientMock.send.mockResolvedValueOnce({ ...SEND_RESULT, success: false });

    const second = await submit(signed).expect(201);

    expect(second.body).toEqual(first.body);
    expect(clientMock.send).toHaveBeenCalledTimes(1);
  });

  it('refuses a tampered transaction (404), without calling DeFindex', async () => {
    const built = TransactionBuilder.fromXDR(
      await buildDeposit(),
      Networks.TESTNET,
    ) as Transaction;
    // Same source, sequence, bounds and vault; a larger amount.
    const tampered = new TransactionBuilder(
      new Account(CALLER, String(BigInt(built.sequence) - 1n)),
      {
        fee: built.fee,
        networkPassphrase: Networks.TESTNET,
        timebounds: built.timeBounds!,
      },
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: VAULT,
          function: 'deposit',
          args: [
            xdr.ScVal.scvVec([i128(990_000_000n)]),
            xdr.ScVal.scvVec([i128(0n)]),
            new Address(CALLER).toScVal(),
            xdr.ScVal.scvBool(true),
          ],
        }),
      )
      .build();

    const res = await submit(sign(tampered.toXDR())).expect(404);

    expect(res.body.code).toBe('not_found');
    expect(clientMock.send).not.toHaveBeenCalled();
  });

  it('refuses an arbitrary signed transaction (404), without calling DeFindex', async () => {
    await buildDeposit();
    const payment = new TransactionBuilder(new Account(CALLER, '7'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '1000',
        }),
      )
      .setTimeout(300)
      .build();

    const res = await submit(sign(payment.toXDR())).expect(404);

    expect(res.body.code).toBe('not_found');
    expect(clientMock.send).not.toHaveBeenCalled();
  });

  it("refuses another key's built transaction (404)", async () => {
    const built = await buildDeposit('cosmos_alice');

    const res = await submit(sign(built), 'cosmos_bob').expect(404);

    expect(res.body.code).toBe('not_found');
    expect(clientMock.send).not.toHaveBeenCalled();
  });

  it('refuses a build that expired before it was submitted (400)', async () => {
    const built = await buildDeposit();
    rows[0].expiresAt = new Date(Date.now() - 1000);

    const res = await submit(sign(built)).expect(400);

    expect(res.body.code).toBe('invalid_state_transition');
    expect(clientMock.send).not.toHaveBeenCalled();
  });

  it('refuses the unsigned envelope the build handed out (400)', async () => {
    const res = await submit(await buildDeposit()).expect(400);

    expect(res.body.code).toBe('validation_failed');
    expect(clientMock.send).not.toHaveBeenCalled();
  });

  it('refuses an oversized amount as 400 before DeFindex is called', async () => {
    const res = await asTenant(
      request(http())
        .post(DEPOSIT)
        .send({ amounts: ['9007199254740992'], caller: CALLER }),
    ).expect(400);

    expect(res.body.code).toBe('validation_failed');
    expect(clientMock.deposit).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  describe('the shared public key', () => {
    const routes: [method: 'get' | 'post', path: string, body?: object][] = [
      ['get', '/v1/defindex/vaults'],
      ['get', `/v1/defindex/vaults/${VAULT}`],
      ['get', `/v1/defindex/vaults/${VAULT}/balance?account=${CALLER}`],
      ['post', DEPOSIT, { amounts: ['1'], caller: CALLER }],
      [
        'post',
        `/v1/defindex/vaults/${VAULT}/withdraw`,
        { shares: '1', caller: CALLER },
      ],
      ['post', SUBMIT, { xdr: 'AAAA' }],
    ];

    for (const [method, path, body] of routes) {
      it(`is refused on ${method.toUpperCase()} ${path.split('?')[0]} (403)`, async () => {
        const call =
          method === 'post'
            ? request(http()).post(path).send(body)
            : request(http()).get(path);

        const res = await asPublicKey(call).expect(403);

        expect(res.body.code).toBe('insufficient_scope');
      });
    }

    it('cannot relay a transaction an account built', async () => {
      const signed = sign(await buildDeposit());

      await asPublicKey(
        request(http()).post(SUBMIT).send({ xdr: signed }),
      ).expect(403);

      expect(clientMock.send).not.toHaveBeenCalled();
    });
  });
});
