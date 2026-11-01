import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Account,
  Address,
  Asset,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { VaultTransactionResponse } from '@defindex/sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { DefindexClient } from '@/native-plugins/defindex/defindex.client';
import type { ExpectedDefindexCall } from '@/native-plugins/defindex/defindex-envelope';
import { DefindexTransactionsService } from '@/native-plugins/defindex/defindex-transactions.service';
import type { PrismaService } from '@/prisma/prisma.service';
import { StellarService } from '@/stellar/stellar.service';

// ── Envelopes, as DeFindex builds them ────────────────────────────────────

const holder = Keypair.random();
const CALLER = holder.publicKey();
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 9));

const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const vec = (values: bigint[]) => xdr.ScVal.scvVec(values.map(i128));

const contractFn = (contract: string, fn: string, args: xdr.ScVal[]) =>
  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: fn,
      args,
    }),
  );

/**
 * A deposit as DeFindex hands one out after simulating it: a 1% minimum, the
 * caller's authorization of the call with the vault's pull of the amount under
 * it, and Soroban resources (the shape a mainnet simulation recorded).
 */
function depositTx(
  amount: bigint,
  passphrase: string = Networks.TESTNET,
  sequence = '41',
  resourceFee = 300_000,
): Transaction {
  const args = [
    vec([amount]),
    vec([(amount * 99n) / 100n]),
    new Address(CALLER).toScVal(),
    xdr.ScVal.scvBool(true),
  ];
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: contractFn(VAULT, 'deposit', args),
      subInvocations: [
        new xdr.SorobanAuthorizedInvocation({
          function: contractFn(TOKEN, 'transfer', [
            new Address(CALLER).toScVal(),
            new Address(VAULT).toScVal(),
            i128(amount),
          ]),
          subInvocations: [],
        }),
      ],
    }),
  });
  return new TransactionBuilder(new Account(CALLER, sequence), {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: VAULT,
        function: 'deposit',
        args,
        auth: [auth],
      }),
    )
    .setSorobanData(
      new SorobanDataBuilder().setResourceFee(resourceFee).build(),
    )
    .setTimeout(300)
    .build();
}

const expectedDeposit = (amount: bigint): ExpectedDefindexCall => ({
  kind: 'deposit',
  vault: VAULT,
  caller: CALLER,
  amounts: [amount],
  invest: true,
  slippageBps: 100,
});

const built = (tx: Transaction): VaultTransactionResponse => ({
  xdr: tx.toXDR(),
  simulationResponse: {},
  functionName: 'deposit',
  params: [],
});

/** The same transaction, signed by its source, as the wallet sends it back. */
function signed(tx: Transaction): string {
  const copy = TransactionBuilder.fromXDR(
    tx.toXDR(),
    tx.networkPassphrase,
  ) as Transaction;
  copy.sign(holder);
  return copy.toXDR();
}

// ── Callers ───────────────────────────────────────────────────────────────

const consumer = (username: string, environment: 'dev' | 'prod' = 'dev') =>
  ({
    username,
    credentialId: null,
    environment,
    role: 'user',
    permissions: ['liquidity:write'],
    organizationId: null,
    plan: null,
    planSwapFeeBps: null,
  }) satisfies GatewayConsumer;

const alice = consumer('cosmos_alice');
const bob = consumer('cosmos_bob');

// ── An in-memory defindex_transaction, one statement at a time ──────────

type Row = {
  id: string;
  consumerId: string;
  network: string;
  kind: 'DEPOSIT' | 'WITHDRAW';
  status: 'BUILT' | 'SUBMITTING' | 'SUBMITTED';
  vault: string;
  caller: string;
  xdr: string;
  txHash: string;
  expiresAt: Date;
  claimedAt: Date | null;
  submittedAt: Date | null;
  result: unknown;
};

type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Where[]).some((branch) => matches(row, branch));
    }
    const value = row[key as keyof Row];
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    if (condition && typeof condition === 'object') {
      const { lt, gte } = condition as { lt?: Date; gte?: Date };
      if (!(value instanceof Date)) return false;
      if (lt && !(value < lt)) return false;
      if (gte && !(value >= gte)) return false;
      return true;
    }
    return value === condition;
  });
}

function table() {
  const rows: Row[] = [];
  let next = 0;
  const copy = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    rows,
    upsert: jest.fn(
      ({
        where,
        create,
      }: {
        where: { consumerId_txHash: { consumerId: string; txHash: string } };
        create: Omit<
          Row,
          'id' | 'status' | 'claimedAt' | 'submittedAt' | 'result'
        >;
      }) => {
        const key = where.consumerId_txHash;
        const existing = rows.find(
          (r) => r.consumerId === key.consumerId && r.txHash === key.txHash,
        );
        if (existing) return Promise.resolve({ ...existing });
        const row: Row = {
          ...create,
          id: `dfx_${++next}`,
          status: 'BUILT',
          claimedAt: null,
          submittedAt: null,
          result: null,
        };
        rows.push(row);
        return Promise.resolve({ ...row });
      },
    ),
    findFirst: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(copy(rows.find((r) => matches(r, where)))),
    ),
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(copy(rows.find((r) => r.id === where.id))),
    ),
    updateMany: jest.fn(
      ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const row of hit) Object.assign(row, data);
        return Promise.resolve({ count: hit.length });
      },
    ),
  };
}

// ── The service under test ────────────────────────────────────────────────

const SEND_RESULT = {
  txHash: 'ab'.repeat(32),
  success: true,
  result: { type: 'vault_deposit', sharesMinted: '9950000' },
  ledger: 61234567,
};

function setup() {
  const defindexTransaction = table();
  const prisma = { defindexTransaction } as unknown as PrismaService;
  const consumers = {
    resolve: jest.fn((c: GatewayConsumer) =>
      Promise.resolve({ id: `local_${c.username}` }),
    ),
    resolveId: jest.fn((c: GatewayConsumer) =>
      Promise.resolve(`local_${c.username}`),
    ),
  } as unknown as ConsumerResolverService;
  const send = jest.fn().mockResolvedValue(SEND_RESULT);
  const client = { send, timeoutMs: 30_000 } as unknown as DefindexClient;
  const config = {
    get: jest.fn((key: string) =>
      key === 'defindex'
        ? { timeoutMs: 30_000, maxFeeStroops: 10_000_000 }
        : { network: 'testnet' },
    ),
  } as unknown as ConfigService;
  const service = new DefindexTransactionsService(
    prisma,
    consumers,
    client,
    new StellarService(config as never),
    config as never,
  );
  return { service, rows: defindexTransaction.rows, send };
}

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('DefindexTransactionsService', () => {
  describe('record', () => {
    it('stores the built transaction by its hash, for the consumer and network', async () => {
      const { service, rows } = setup();
      const tx = depositTx(10_000_000n);

      await service.record(
        alice,
        'testnet',
        expectedDeposit(10_000_000n),
        built(tx),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        consumerId: 'local_cosmos_alice',
        network: 'testnet',
        kind: 'DEPOSIT',
        vault: VAULT,
        caller: CALLER,
        xdr: tx.toXDR(),
        txHash: Buffer.from(tx.hash()).toString('hex'),
        status: 'BUILT',
      });
      // The envelope closes in 300 s, before the 15-minute cap.
      expect(rows[0].expiresAt.getTime()).toBe(
        Number(tx.timeBounds!.maxTime) * 1000,
      );
    });

    it('stores nothing when DeFindex built another call', async () => {
      const { service, rows } = setup();
      const error = await refusal(
        service.record(
          alice,
          'testnet',
          expectedDeposit(10_000_000n),
          built(depositTx(99n)),
        ),
      );
      expect(error.getStatus()).toBe(502);
      expect(error.code).toBe(ApiErrorCode.ProviderError);
      expect(rows).toHaveLength(0);
    });

    it('logs why and stores nothing when the fee is above the cap', async () => {
      const { service, rows } = setup();
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const tx = depositTx(10_000_000n, Networks.TESTNET, '41', 12_000_000);

      const error = await refusal(
        service.record(
          alice,
          'testnet',
          expectedDeposit(10_000_000n),
          built(tx),
        ),
      );

      expect(error.getStatus()).toBe(502);
      expect(error.message).toMatch(
        /its fee 12000100 exceeds 10000000 stroops/,
      );
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(
          `Refused a DeFindex deposit build for cosmos_alice on testnet (vault ${VAULT}): its fee`,
        ),
      );
      expect(rows).toHaveLength(0);
      logged.mockRestore();
    });

    it('stores nothing when DeFindex returned no transaction', async () => {
      const { service, rows } = setup();
      const error = await refusal(
        service.record(alice, 'testnet', expectedDeposit(1n), {
          ...built(depositTx(1n)),
          xdr: null,
        }),
      );
      expect(error.code).toBe(ApiErrorCode.ProviderError);
      expect(rows).toHaveLength(0);
    });
  });

  describe('submit', () => {
    async function builtFor(
      service: DefindexTransactionsService,
      who: GatewayConsumer = alice,
      amount = 10_000_000n,
    ) {
      const tx = depositTx(amount);
      await service.record(who, 'testnet', expectedDeposit(amount), built(tx));
      return tx;
    }

    it('relays a signed copy of a transaction built for the caller', async () => {
      const { service, rows, send } = setup();
      const tx = await builtFor(service);

      await expect(service.submit(alice, signed(tx))).resolves.toEqual(
        SEND_RESULT,
      );

      expect(send).toHaveBeenCalledTimes(1);
      const [network, relayed] = send.mock.calls[0] as [string, string];
      expect(network).toBe('testnet');
      expect(relayed).toBe(signed(tx));
      expect(rows[0]).toMatchObject({
        status: 'SUBMITTED',
        result: SEND_RESULT,
      });
    });

    it('answers a replay with the first result and never resubmits', async () => {
      const { service, send } = setup();
      const tx = await builtFor(service);
      const first = await service.submit(alice, signed(tx));
      send.mockResolvedValue({ ...SEND_RESULT, success: false });

      const second = await service.submit(alice, signed(tx));

      expect(second).toEqual(first);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('refuses a tampered transaction as 404, without calling DeFindex', async () => {
      const { service, send } = setup();
      await builtFor(service, alice, 10_000_000n);
      // Same source, sequence and vault; only the amount differs.
      const tampered = depositTx(90_000_000n);

      const error = await refusal(service.submit(alice, signed(tampered)));

      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe(ApiErrorCode.NotFound);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses an unrelated transaction as 404, without calling DeFindex', async () => {
      const { service, send } = setup();
      await builtFor(service);
      const unrelated = new TransactionBuilder(new Account(CALLER, '41'), {
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

      const error = await refusal(service.submit(alice, signed(unrelated)));

      expect(error.code).toBe(ApiErrorCode.NotFound);
      expect(send).not.toHaveBeenCalled();
    });

    it("refuses another consumer's built transaction as 404", async () => {
      const { service, send } = setup();
      const tx = await builtFor(service, alice);

      const error = await refusal(service.submit(bob, signed(tx)));

      expect(error.getStatus()).toBe(404);
      expect(send).not.toHaveBeenCalled();
    });

    it("refuses it to the same account's key on the other network", async () => {
      const { service, send } = setup();
      const tx = await builtFor(service, alice);

      // A prod key parses the envelope under mainnet's passphrase.
      const error = await refusal(
        service.submit(consumer('cosmos_alice', 'prod'), signed(tx)),
      );

      expect(error.code).toBe(ApiErrorCode.NotFound);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses an expired build as 400 invalid_state_transition', async () => {
      const { service, rows, send } = setup();
      const tx = await builtFor(service);
      rows[0].expiresAt = new Date(Date.now() - 1000);

      const error = await refusal(service.submit(alice, signed(tx)));

      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(send).not.toHaveBeenCalled();
      expect(rows[0].status).toBe('BUILT');
    });

    it('still answers the stored result after the build expired', async () => {
      const { service, rows } = setup();
      const tx = await builtFor(service);
      await service.submit(alice, signed(tx));
      rows[0].expiresAt = new Date(Date.now() - 1000);

      await expect(service.submit(alice, signed(tx))).resolves.toEqual(
        SEND_RESULT,
      );
    });

    it('refuses the unsigned envelope the build handed out', async () => {
      const { service, send } = setup();
      const tx = await builtFor(service);

      const error = await refusal(service.submit(alice, tx.toXDR()));

      expect(error.code).toBe(ApiErrorCode.ValidationFailed);
      expect(send).not.toHaveBeenCalled();
    });

    it('lets one of two concurrent submits through and answers the other 409', async () => {
      const { service, send } = setup();
      const tx = await builtFor(service);
      let answer!: (value: unknown) => void;
      send.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );

      const first = service.submit(alice, signed(tx));
      await new Promise((resolve) => setImmediate(resolve));
      const error = await refusal(service.submit(alice, signed(tx)));
      answer(SEND_RESULT);

      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe(ApiErrorCode.OperationInFlight);
      await expect(first).resolves.toEqual(SEND_RESULT);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('releases the claim when DeFindex gives no answer, so a retry can send', async () => {
      const { service, rows, send } = setup();
      const tx = await builtFor(service);
      send.mockRejectedValueOnce(
        ApiError.badGateway(
          ApiErrorCode.ProviderError,
          'DeFindex request failed',
        ),
      );

      const error = await refusal(service.submit(alice, signed(tx)));
      expect(error.getStatus()).toBe(502);
      expect(rows[0]).toMatchObject({ status: 'BUILT', claimedAt: null });

      await expect(service.submit(alice, signed(tx))).resolves.toEqual(
        SEND_RESULT,
      );
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('takes over a claim abandoned past the DeFindex timeout', async () => {
      const { service, rows, send } = setup();
      const tx = await builtFor(service);
      Object.assign(rows[0], {
        status: 'SUBMITTING',
        claimedAt: new Date(Date.now() - 5 * 60_000),
      });

      await expect(service.submit(alice, signed(tx))).resolves.toEqual(
        SEND_RESULT,
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(rows[0].status).toBe('SUBMITTED');
    });
  });
});
