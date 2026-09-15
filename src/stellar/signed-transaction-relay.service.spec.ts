import { HttpStatus, Logger } from '@nestjs/common';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  RelayProfile,
  RelayRow,
  SignedTransactionRelay,
} from '@/stellar/signed-transaction-relay.service';

/**
 * The relay is pinned here against a fake settlement machine, one step at a
 * time. The races it exists for — the observer settling a row in the middle of a
 * broadcast — are also exercised end to end, with the real repository, in the
 * swaps and liquidity-pools specs.
 */

const SIGNER = Keypair.random();
const USERNAME = 'cosmos_u1';

/** A real signed envelope, and the hash it has under `networkPassphrase`. */
function signedEnvelope(
  sequence = '1',
  networkPassphrase: string = Networks.TESTNET,
) {
  const tx = new TransactionBuilder(new Account(SIGNER.publicKey(), sequence), {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: SIGNER.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(300)
    .build();
  tx.sign(SIGNER);
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex') };
}

const SIGNED = signedEnvelope();

function row(overrides: Partial<RelayRow> = {}): RelayRow {
  return {
    id: 'row_1',
    status: 'PENDING',
    settlementEpoch: 0,
    network: 'testnet',
    txHash: SIGNED.hash,
    ...overrides,
  };
}

function horizonReject(codes: { transaction?: string; operations?: string[] }) {
  const err: any = new Error('Horizon rejected the transaction');
  err.response = { data: { extras: { result_codes: codes } } };
  return err;
}

/** Stellar whose broadcast confirms unless a test says otherwise. */
function makeStellar() {
  const submitTransaction = jest.fn().mockResolvedValue({ hash: SIGNED.hash });
  return {
    passphrase: jest.fn((network: string) =>
      network === 'public' ? Networks.PUBLIC : Networks.TESTNET,
    ),
    server: jest.fn().mockReturnValue({ submitTransaction }),
    submitTransaction,
  };
}

/**
 * A settlement machine over one in-memory row with SettlementRepository's
 * compare-and-swap semantics: a transition applies only from the statuses it
 * names, and always reports the row as it is afterwards.
 */
function makeSettlement(start: RelayRow) {
  let current = { ...start };
  const move = (from: RelayRow['status'][], to: RelayRow['status']) => {
    const applied = from.includes(current.status);
    if (applied) current = { ...current, status: to };
    return { applied, row: { ...current } };
  };
  return {
    status: () => current.status,
    force: (status: RelayRow['status']) => {
      current = { ...current, status };
    },
    markSubmitted: jest.fn(async (_id: string) =>
      move(['PENDING', 'FAILED'], 'SUBMITTED'),
    ),
    finalizeSucceeded: jest.fn(
      async (_id: string, _username: string, _txHash?: string) =>
        move(['PENDING', 'SUBMITTED', 'FAILED', 'EXPIRED'], 'SUCCEEDED'),
    ),
    finalizeFailed: jest.fn(async (_id: string, _username: string) =>
      move(['PENDING', 'SUBMITTED'], 'FAILED'),
    ),
  };
}

type View = { id: string; status: string; note?: string };

function makeProfile(
  settlement: ReturnType<typeof makeSettlement>,
  overrides: Partial<RelayProfile<RelayRow, View>> = {},
): RelayProfile<RelayRow, View> & { emit: jest.Mock } {
  return {
    settlement,
    submittedEvent: 'SWAP_SUBMITTED',
    emit: jest.fn().mockResolvedValue(true),
    present: async (r: RelayRow) => ({ id: r.id, status: r.status }),
    labels: { resource: 'swap', match: 'swap', log: 'Swap' },
    logger: {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger,
    ...overrides,
  } as RelayProfile<RelayRow, View> & { emit: jest.Mock };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('SignedTransactionRelay', () => {
  let stellar: ReturnType<typeof makeStellar>;
  let relay: SignedTransactionRelay;

  beforeEach(() => {
    stellar = makeStellar();
    relay = new SignedTransactionRelay(stellar as never);
  });

  it('answers an already-settled row without touching the network', async () => {
    const settled = row({ status: 'SUCCEEDED' });
    const settlement = makeSettlement(settled);

    const outcome = await relay.submit(
      settled,
      USERNAME,
      'not even an envelope',
      makeProfile(settlement),
    );

    expect(outcome).toEqual({
      submitted: true,
      status: 'SUCCEEDED',
      txHash: SIGNED.hash,
      view: { id: 'row_1', status: 'SUCCEEDED' },
    });
    expect(settlement.markSubmitted).not.toHaveBeenCalled();
    expect(stellar.submitTransaction).not.toHaveBeenCalled();
  });

  it('refuses a row that can no longer settle', async () => {
    const expired = row({ status: 'EXPIRED' });
    const settlement = makeSettlement(expired);

    const err = await refusal(
      relay.submit(expired, USERNAME, SIGNED.xdr, makeProfile(settlement)),
    );

    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
    expect(err.message).toBe('Cannot submit a EXPIRED swap');
    expect(settlement.markSubmitted).not.toHaveBeenCalled();
  });

  it('refuses something that is not a transaction envelope', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);

    const err = await refusal(
      relay.submit(pending, USERNAME, 'AAAA', makeProfile(settlement)),
    );

    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(err.message).toBe('signedXdr is not a valid transaction envelope');
    expect(settlement.markSubmitted).not.toHaveBeenCalled();
  });

  it('refuses a signed envelope that is not the one built for the row', async () => {
    // Otherwise a caller could have us broadcast an arbitrary transaction.
    const pending = row();
    const settlement = makeSettlement(pending);
    const other = signedEnvelope('41');

    const err = await refusal(
      relay.submit(
        pending,
        USERNAME,
        other.xdr,
        makeProfile(settlement, {
          labels: {
            resource: 'liquidity pool operation',
            match: 'operation',
            log: 'LP operation',
          },
        }),
      ),
    );

    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(err.message).toBe(
      'The signed transaction does not match this operation',
    );
    expect(settlement.markSubmitted).not.toHaveBeenCalled();
    expect(stellar.submitTransaction).not.toHaveBeenCalled();
  });

  it("checks the hash under the row's stored network, not any other", async () => {
    // The same bytes hash differently per passphrase: an envelope signed for
    // testnet is not the public-network transaction this row stored.
    const publicRow = row({ network: 'public' });
    const settlement = makeSettlement(publicRow);

    const err = await refusal(
      relay.submit(publicRow, USERNAME, SIGNED.xdr, makeProfile(settlement)),
    );

    expect(stellar.passphrase).toHaveBeenCalledWith('public');
    expect(err.message).toBe('The signed transaction does not match this swap');
  });

  it('marks the row SUBMITTED, announces it once, and settles on a confirmed broadcast', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    const profile = makeProfile(settlement);

    const outcome = await relay.submit(pending, USERNAME, SIGNED.xdr, profile);

    expect(settlement.markSubmitted).toHaveBeenCalledWith('row_1');
    expect(profile.emit).toHaveBeenCalledTimes(1);
    expect(profile.emit).toHaveBeenCalledWith(
      USERNAME,
      'SWAP_SUBMITTED',
      expect.objectContaining({ id: 'row_1', status: 'SUBMITTED' }),
    );
    expect(stellar.server).toHaveBeenCalledWith('testnet');
    expect(settlement.finalizeSucceeded).toHaveBeenCalledWith(
      'row_1',
      USERNAME,
      SIGNED.hash,
    );
    // The response is serialized in this key order.
    expect(Object.keys(outcome)).toEqual([
      'submitted',
      'status',
      'txHash',
      'view',
    ]);
    expect(outcome).toEqual({
      submitted: true,
      status: 'SUCCEEDED',
      txHash: SIGNED.hash,
      view: { id: 'row_1', status: 'SUCCEEDED' },
    });
  });

  it('does not announce a submission this call did not win', async () => {
    // A retry after an unreachable Horizon finds the row already SUBMITTED.
    const submitted = row({ status: 'SUBMITTED' });
    const settlement = makeSettlement(submitted);
    const profile = makeProfile(settlement);

    const outcome = await relay.submit(
      submitted,
      USERNAME,
      SIGNED.xdr,
      profile,
    );

    expect(profile.emit).not.toHaveBeenCalled();
    expect(outcome.status).toBe('SUCCEEDED');
  });

  it('presents the row the post-settlement hook returns', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    const afterSucceeded = jest.fn(async (settled: RelayRow) => ({
      ...settled,
      note: 'basis captured',
    }));

    const outcome = await relay.submit(
      pending,
      USERNAME,
      SIGNED.xdr,
      makeProfile(settlement, {
        afterSucceeded,
        present: async (r: RelayRow & { note?: string }) => ({
          id: r.id,
          status: r.status,
          note: r.note,
        }),
      }),
    );

    expect(afterSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
    expect(outcome.view).toEqual({
      id: 'row_1',
      status: 'SUCCEEDED',
      note: 'basis captured',
    });
  });

  it('answers SUCCEEDED without broadcasting when the observer settled the row first', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    settlement.markSubmitted.mockImplementationOnce(async () => {
      settlement.force('SUCCEEDED');
      return {
        applied: false,
        row: { ...pending, status: 'SUCCEEDED' as const },
      };
    });
    const afterSucceeded = jest.fn();
    const profile = makeProfile(settlement, { afterSucceeded });

    const outcome = await relay.submit(pending, USERNAME, SIGNED.xdr, profile);

    expect(outcome.status).toBe('SUCCEEDED');
    expect(stellar.submitTransaction).not.toHaveBeenCalled();
    expect(profile.emit).not.toHaveBeenCalled();
    // The writer that settled it ran the hook.
    expect(afterSucceeded).not.toHaveBeenCalled();
  });

  it('refuses when the row left the submittable states before SUBMITTED was written', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    settlement.markSubmitted.mockResolvedValueOnce({
      applied: false,
      row: { ...pending, status: 'EXPIRED' as const },
    });

    const err = await refusal(
      relay.submit(pending, USERNAME, SIGNED.xdr, makeProfile(settlement)),
    );

    expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
    expect(err.message).toBe('Cannot submit a EXPIRED swap');
    expect(stellar.submitTransaction).not.toHaveBeenCalled();
  });

  it('finalizes FAILED with the result codes when the network rejects it', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    stellar.submitTransaction.mockRejectedValue(
      horizonReject({
        transaction: 'tx_failed',
        operations: ['op_underfunded'],
      }),
    );

    const outcome = await relay.submit(
      pending,
      USERNAME,
      SIGNED.xdr,
      makeProfile(settlement),
    );

    expect(settlement.finalizeFailed).toHaveBeenCalledWith('row_1', USERNAME);
    expect(Object.keys(outcome)).toEqual([
      'submitted',
      'status',
      'reason',
      'resultCodes',
      'view',
    ]);
    expect(outcome).toEqual({
      submitted: false,
      status: 'FAILED',
      reason: 'Transaction rejected by the network',
      resultCodes: ['tx_failed', 'op_underfunded'],
      view: { id: 'row_1', status: 'FAILED' },
    });
  });

  it('reports SUCCEEDED, not a rejection, when the observer settled the hash during the broadcast', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    stellar.submitTransaction.mockImplementation(async () => {
      settlement.force('SUCCEEDED');
      throw horizonReject({ transaction: 'tx_already_included' });
    });

    const outcome = await relay.submit(
      pending,
      USERNAME,
      SIGNED.xdr,
      makeProfile(settlement),
    );

    expect(outcome).toEqual({
      submitted: true,
      status: 'SUCCEEDED',
      txHash: SIGNED.hash,
      view: { id: 'row_1', status: 'SUCCEEDED' },
    });
    expect(settlement.status()).toBe('SUCCEEDED');
  });

  it('answers 503 and leaves the row re-submittable when Horizon is unreachable', async () => {
    const pending = row();
    const settlement = makeSettlement(pending);
    stellar.submitTransaction.mockRejectedValue(new Error('socket hang up'));

    const err = await refusal(
      relay.submit(pending, USERNAME, SIGNED.xdr, makeProfile(settlement)),
    );

    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.code).toBe(ApiErrorCode.ProviderUnavailable);
    expect(settlement.finalizeFailed).not.toHaveBeenCalled();
    expect(settlement.finalizeSucceeded).not.toHaveBeenCalled();
    expect(settlement.status()).toBe('SUBMITTED');
  });
});
