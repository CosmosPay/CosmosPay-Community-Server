import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { PrismaService } from '@/prisma/prisma.service';
import { StellarService } from '@/stellar/stellar.service';
import type { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import type { ExpectedTrustlessWorkCall } from '@/native-plugins/trustless-work/trustless-work-envelope';
import { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';

// ── Envelopes, as Trustless Work builds them ─────────────────────────────

const buyer = Keypair.random();
const BUYER = buyer.publicKey();
const platform = Keypair.random();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 2));

/** `approve_milestone(0, approver)`, simulated, with the approver's auth. */
function approveTx(
  signer = BUYER,
  sequence = '41',
  passphrase: string = Networks.TESTNET,
): Transaction {
  const args = [xdr.ScVal.scvU32(0), new Address(signer).toScVal()];
  return new TransactionBuilder(new Account(signer, sequence), {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'approve_milestone',
        args,
        auth: [
          new xdr.SorobanAuthorizationEntry({
            credentials:
              xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
              function:
                xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                  new xdr.InvokeContractArgs({
                    contractAddress: new Address(CONTRACT).toScAddress(),
                    functionName: 'approve_milestone',
                    args,
                  }),
                ),
              subInvocations: [],
            }),
          }),
        ],
      }),
    )
    .setSorobanData(new SorobanDataBuilder().setResourceFee(200_000).build())
    .setTimeout(300)
    .build();
}

const approve = (signer = BUYER): ExpectedTrustlessWorkCall => ({
  action: 'APPROVE',
  signer,
  contractId: CONTRACT,
  milestoneIndex: 0,
});

function signed(tx: Transaction, key = buyer): string {
  const copy = TransactionBuilder.fromXDR(
    tx.toXDR(),
    tx.networkPassphrase,
  ) as Transaction;
  copy.sign(key);
  return copy.toXDR();
}

const PAYMENT = { id: 'pp_1', consumerId: 'local_alice', network: 'testnet' };

// ── An in-memory protected_payment_transaction ───────────────────────────

type Row = {
  id: string;
  protectedPaymentId: string;
  consumerId: string;
  network: string;
  action: string;
  status: 'BUILT' | 'SUBMITTING' | 'SUBMITTED';
  signer: string;
  xdr: string;
  txHash: string;
  context: unknown;
  expiresAt: Date;
  claimedAt: Date | null;
  submittedAt: Date | null;
  result: unknown;
  createdAt: Date;
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
      const {
        lt,
        gte,
        in: among,
      } = condition as {
        lt?: Date;
        gte?: Date;
        in?: unknown[];
      };
      if (among) return among.includes(value);
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
        create: Partial<Row>;
      }) => {
        const key = where.consumerId_txHash;
        const existing = rows.find(
          (r) => r.consumerId === key.consumerId && r.txHash === key.txHash,
        );
        if (existing) return Promise.resolve({ ...existing });
        const row = {
          context: null,
          ...create,
          id: `ppt_${++next}`,
          status: 'BUILT',
          claimedAt: null,
          submittedAt: null,
          result: null,
          createdAt: new Date(),
        } as Row;
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
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
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

const SENT = {
  status: 'SUCCESS',
  message: 'The transaction has been successfully sent to the Stellar network.',
};

function setup() {
  const protectedPaymentTransaction = table();
  const prisma = { protectedPaymentTransaction } as unknown as PrismaService;
  const send = jest.fn().mockResolvedValue(SENT);
  const client = { send, timeoutMs: 30_000 } as unknown as TrustlessWorkClient;
  const config = {
    get: jest.fn((key: string) =>
      key === 'trustlessWork'
        ? { timeoutMs: 30_000, maxFeeStroops: 20_000_000 }
        : { network: 'testnet' },
    ),
  } as unknown as ConfigService;
  const service = new ProtectedPaymentTransactionsService(
    prisma,
    client,
    new StellarService(config as never),
    config as never,
  );
  return { service, rows: protectedPaymentTransaction.rows, send };
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

const SCOPE = {
  protectedPaymentId: 'pp_1',
  network: 'testnet' as const,
  signer: BUYER,
};

describe('ProtectedPaymentTransactionsService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('record', () => {
    it('stores the checked envelope by its hash, for the payment, its merchant and network', async () => {
      const { service, rows } = setup();
      const tx = approveTx();
      await service.record(PAYMENT, approve(), tx.toXDR());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        protectedPaymentId: 'pp_1',
        consumerId: 'local_alice',
        network: 'testnet',
        action: 'APPROVE',
        signer: BUYER,
        txHash: Buffer.from(tx.hash()).toString('hex'),
        status: 'BUILT',
      });
      expect(rows[0].expiresAt.getTime()).toBe(
        Number(tx.timeBounds!.maxTime) * 1000,
      );
    });

    it('stores nothing, logs and answers 502 when the envelope is another call', async () => {
      const { service, rows } = setup();
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const error = await refusal(
        service.record(
          PAYMENT,
          approve(BUYER),
          approveTx(platform.publicKey()).toXDR(),
        ),
      );
      expect(error.getStatus()).toBe(502);
      expect(error.code).toBe(ApiErrorCode.ProviderError);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(
          'Refused a Trustless Work approve build for protected payment pp_1 on testnet',
        ),
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('submitSigned', () => {
    async function built(service: ProtectedPaymentTransactionsService) {
      const tx = approveTx();
      await service.record(PAYMENT, approve(), tx.toXDR());
      return tx;
    }

    it('relays a signed copy once and stores the answer', async () => {
      const { service, rows, send } = setup();
      const tx = await built(service);

      const outcome = await service.submitSigned(SCOPE, signed(tx));

      expect(outcome.succeeded).toBe(true);
      expect(outcome.result).toEqual(SENT);
      expect(send).toHaveBeenCalledWith('testnet', signed(tx));
      expect(rows[0]).toMatchObject({ status: 'SUBMITTED', result: SENT });
    });

    it('answers a replay with the stored answer and never relays again', async () => {
      const { service, send } = setup();
      const tx = await built(service);
      await service.submitSigned(SCOPE, signed(tx));
      send.mockResolvedValue({ status: 'FAILED', message: 'tx_bad_seq' });

      const replay = await service.submitSigned(SCOPE, signed(tx));

      expect(replay.result).toEqual(SENT);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('refuses a tampered or unrelated transaction as 404, without relaying', async () => {
      const { service, send } = setup();
      await built(service);
      const other = approveTx(BUYER, '99');
      const error = await refusal(service.submitSigned(SCOPE, signed(other)));
      expect(error.getStatus()).toBe(404);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses it for another payment, another signer or another network', async () => {
      const { service, send } = setup();
      const tx = await built(service);
      for (const scope of [
        { ...SCOPE, protectedPaymentId: 'pp_2' },
        { ...SCOPE, signer: platform.publicKey() },
        { ...SCOPE, consumerId: 'local_bob' },
      ]) {
        expect(
          (await refusal(service.submitSigned(scope, signed(tx)))).code,
        ).toBe(ApiErrorCode.NotFound);
      }
      // Parsed under mainnet's passphrase, it hashes to nothing built here.
      expect(
        (
          await refusal(
            service.submitSigned({ ...SCOPE, network: 'public' }, signed(tx)),
          )
        ).code,
      ).toBe(ApiErrorCode.NotFound);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses an expired build as 400 invalid_state_transition', async () => {
      const { service, rows, send } = setup();
      const tx = await built(service);
      rows[0].expiresAt = new Date(Date.now() - 1000);
      const error = await refusal(service.submitSigned(SCOPE, signed(tx)));
      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(send).not.toHaveBeenCalled();
    });

    it('still answers the stored result after the build expired', async () => {
      const { service, rows } = setup();
      const tx = await built(service);
      await service.submitSigned(SCOPE, signed(tx));
      rows[0].expiresAt = new Date(Date.now() - 1000);
      await expect(
        service.submitSigned(SCOPE, signed(tx)),
      ).resolves.toMatchObject({
        result: SENT,
      });
    });

    it('refuses the unsigned envelope as 400 validation_failed', async () => {
      const { service } = setup();
      const tx = await built(service);
      expect(
        (await refusal(service.submitSigned(SCOPE, tx.toXDR()))).code,
      ).toBe(ApiErrorCode.ValidationFailed);
    });

    it('lets one of two concurrent submits through and answers the other 409', async () => {
      const { service, send } = setup();
      const tx = await built(service);
      let answer!: (value: unknown) => void;
      send.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      const first = service.submitSigned(SCOPE, signed(tx));
      await new Promise((resolve) => setImmediate(resolve));
      const error = await refusal(service.submitSigned(SCOPE, signed(tx)));
      answer(SENT);
      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe(ApiErrorCode.OperationInFlight);
      await expect(first).resolves.toMatchObject({ succeeded: true });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('releases the claim when Trustless Work gives no answer, so a retry can relay', async () => {
      const { service, rows, send } = setup();
      const tx = await built(service);
      send.mockRejectedValueOnce(
        ApiError.badGateway(
          ApiErrorCode.ProviderError,
          'Trustless Work returned an error.',
        ),
      );
      expect(
        (await refusal(service.submitSigned(SCOPE, signed(tx)))).getStatus(),
      ).toBe(502);
      expect(rows[0]).toMatchObject({ status: 'BUILT', claimedAt: null });
      await expect(
        service.submitSigned(SCOPE, signed(tx)),
      ).resolves.toMatchObject({
        succeeded: true,
      });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('takes over a claim abandoned past the Trustless Work timeout', async () => {
      const { service, rows, send } = setup();
      const tx = await built(service);
      Object.assign(rows[0], {
        status: 'SUBMITTING',
        claimedAt: new Date(Date.now() - 5 * 60_000),
      });
      await expect(
        service.submitSigned(SCOPE, signed(tx)),
      ).resolves.toMatchObject({
        succeeded: true,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(rows[0].status).toBe('SUBMITTED');
    });

    it('reports a FAILED answer as stored but not landed', async () => {
      const { service, send } = setup();
      const tx = await built(service);
      send.mockResolvedValue({ status: 'FAILED', message: 'tx_failed' });
      await expect(
        service.submitSigned(SCOPE, signed(tx)),
      ).resolves.toMatchObject({
        succeeded: false,
        result: { status: 'FAILED' },
      });
    });
  });

  describe('relayServerSigned', () => {
    it("signs a recorded row with this server's key and relays it", async () => {
      const { service, send } = setup();
      const tx = approveTx(platform.publicKey());
      const { row } = await service.record(
        PAYMENT,
        approve(platform.publicKey()),
        tx.toXDR(),
      );
      await service.relayServerSigned(row, platform);
      const relayed = TransactionBuilder.fromXDR(
        (send.mock.calls[0] as [string, string])[1],
        Networks.TESTNET,
      ) as Transaction;
      expect(relayed.signatures).toHaveLength(1);
      expect(Buffer.from(relayed.hash()).toString('hex')).toBe(row.txHash);
    });

    it('refuses to sign a row with a key that is not its signer', async () => {
      const { service, send } = setup();
      const { row } = await service.record(
        PAYMENT,
        approve(),
        approveTx().toXDR(),
      );
      await expect(service.relayServerSigned(row, platform)).rejects.toThrow(
        /Refusing to sign/,
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('says a fund handed out and unexpired can still land', async () => {
    const { service, rows } = setup();
    await service.record(PAYMENT, approve(), approveTx().toXDR());
    rows[0].action = 'FUND';
    await expect(service.outstanding('pp_1', 'FUND', new Date())).resolves.toBe(
      true,
    );
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.outstanding('pp_1', 'FUND', new Date())).resolves.toBe(
      false,
    );
  });
});
