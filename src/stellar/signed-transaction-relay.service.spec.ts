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
import { SETTLEMENT_MAX_RESUBMITS } from '@/stellar/stellar.constants';

/**
 * The relay is pinned here against a fake settlement machine, one step at a
 * time. The races it exists for — the observer settling a row in the middle of a
 * broadcast — are also exercised end to end, with the real repository, in the
 * swaps and liquidity-pools specs.
 */

const SIGNER = Keypair.random();
const USERNAME = 'cosmos_u1';

interface EnvelopeOptions {
  /** The source account's sequence; a different one is a different transaction. */
  sequence?: string;
  networkPassphrase?: string;
  /** Close the time bounds at this unix second instead of five minutes out. */
  maxTime?: number;
}

/**
 * A real envelope, both as the create response hands it out (`unsigned`) and as
 * the wallet sends it back (`xdr`), with the hash they share under
 * `networkPassphrase` — signing does not change it.
 */
function envelope({
  sequence = '1',
  networkPassphrase = Networks.TESTNET,
  maxTime,
}: EnvelopeOptions = {}) {
  const builder = new TransactionBuilder(
    new Account(SIGNER.publicKey(), sequence),
    { fee: '100', networkPassphrase },
  ).addOperation(
    Operation.payment({
      destination: SIGNER.publicKey(),
      asset: Asset.native(),
      amount: '1',
    }),
  );
  if (maxTime === undefined) builder.setTimeout(300);
  else builder.setTimebounds(0, maxTime);
  const tx = builder.build();
  const unsigned = tx.toXDR();
  tx.sign(SIGNER);
  return {
    unsigned,
    xdr: tx.toXDR(),
    hash: Buffer.from(tx.hash()).toString('hex'),
  };
}

const SIGNED = envelope();

function row(overrides: Partial<RelayRow> = {}): RelayRow {
  return {
    id: 'row_1',
    status: 'PENDING',
    settlementEpoch: 0,
    network: 'testnet',
    txHash: SIGNED.hash,
    expiresAt: new Date(Date.now() + 300_000),
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
    epoch: () => current.settlementEpoch,
    /** The row as a fresh read would return it. */
    read: () => ({ ...current }),
    force: (
      status: RelayRow['status'],
      settlementEpoch = current.settlementEpoch,
    ) => {
      current = { ...current, status, settlementEpoch };
    },
    // FAILED → SUBMITTED bumps the epoch, and only below the cap; otherwise
    // PENDING → SUBMITTED. As the repository's markSubmitted does.
    markSubmitted: jest.fn(async (_id: string) => {
      if (
        current.status === 'FAILED' &&
        current.settlementEpoch < SETTLEMENT_MAX_RESUBMITS
      ) {
        current = {
          ...current,
          status: 'SUBMITTED',
          settlementEpoch: current.settlementEpoch + 1,
        };
        return { applied: true, row: { ...current } };
      }
      return move(['PENDING'], 'SUBMITTED');
    }),
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
): RelayProfile<RelayRow, View> & { emit: jest.Mock; present: jest.Mock } {
  return {
    settlement,
    submittedEvent: 'SWAP_SUBMITTED',
    emit: jest.fn().mockResolvedValue(true),
    present: jest.fn(async (r: RelayRow) => ({ id: r.id, status: r.status })),
    labels: { resource: 'swap', match: 'swap', log: 'Swap' },
    logger: {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger,
    ...overrides,
  } as RelayProfile<RelayRow, View> & { emit: jest.Mock; present: jest.Mock };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const NO_SIGNATURES =
  'signedXdr carries no signatures; sign the transaction before submitting it';
const EXPIRED =
  "This swap's transaction expired and can no longer be submitted. If it " +
  'reached the network before then, it will still settle.';
const RESUBMITS_EXHAUSTED =
  `Cannot submit a FAILED swap again: it was already resubmitted ` +
  `${SETTLEMENT_MAX_RESUBMITS} times after a rejection. Build a new swap.`;

describe('SignedTransactionRelay', () => {
  let stellar: ReturnType<typeof makeStellar>;
  let relay: SignedTransactionRelay;

  beforeEach(() => {
    stellar = makeStellar();
    relay = new SignedTransactionRelay(stellar as never);
  });

  describe('the envelope is checked before anything about the row is answered', () => {
    // Under the shared public key every anonymous wallet is one consumer, so
    // ownership filtering does not separate them: a row id is all a stranger
    // needs to reach this method. The envelope is what they do not have.

    it('answers a retry of the settled envelope without touching the network', async () => {
      const settled = row({ status: 'SUCCEEDED' });
      const settlement = makeSettlement(settled);

      const outcome = await relay.submit(
        settled,
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
      expect(settlement.markSubmitted).not.toHaveBeenCalled();
      expect(stellar.submitTransaction).not.toHaveBeenCalled();
    });

    it('does not present a settled row for something that is not an envelope', async () => {
      const settled = row({ status: 'SUCCEEDED' });
      const profile = makeProfile(makeSettlement(settled));

      const err = await refusal(
        relay.submit(settled, USERNAME, 'not even an envelope', profile),
      );

      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toBe('signedXdr is not a valid transaction envelope');
      expect(profile.present).not.toHaveBeenCalled();
    });

    it("does not present a settled row for another row's envelope", async () => {
      const settled = row({ status: 'SUCCEEDED' });
      const profile = makeProfile(makeSettlement(settled));

      const err = await refusal(
        relay.submit(
          settled,
          USERNAME,
          envelope({ sequence: '41' }).xdr,
          profile,
        ),
      );

      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toBe(
        'The signed transaction does not match this swap',
      );
      expect(profile.present).not.toHaveBeenCalled();
    });

    it("does not reveal a row's status to an envelope that is not its own", async () => {
      // "Cannot submit a EXPIRED swap" used to come back for any junk body.
      const expired = row({ status: 'EXPIRED' });

      const err = await refusal(
        relay.submit(
          expired,
          USERNAME,
          'AAAA',
          makeProfile(makeSettlement(expired)),
        ),
      );

      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).not.toMatch(/EXPIRED/);
    });

    it.each(['PENDING', 'SUBMITTED', 'FAILED', 'SUCCEEDED'] as const)(
      'refuses the unsigned envelope from the create response against a %s row',
      async (status) => {
        // Its hash matches — signatures do not change it — so without this an
        // unsigned envelope was enough to broadcast, fail, and resubmit forever.
        const target = row({ status });
        const settlement = makeSettlement(target);
        const profile = makeProfile(settlement);

        const err = await refusal(
          relay.submit(target, USERNAME, SIGNED.unsigned, profile),
        );

        expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(err.code).toBe(ApiErrorCode.ValidationFailed);
        expect(err.message).toBe(NO_SIGNATURES);
        expect(settlement.markSubmitted).not.toHaveBeenCalled();
        expect(stellar.submitTransaction).not.toHaveBeenCalled();
        expect(profile.present).not.toHaveBeenCalled();
      },
    );
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
    const other = envelope({ sequence: '41' });

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

  describe('an envelope past its lifetime is never broadcast', () => {
    // The network would only answer `tx_too_late`, and a FAILED row answered
    // that way would bump its epoch for nothing. The row is left as it is: the
    // observer settles an in-flight one from the ledger — SUCCEEDED if it landed
    // before its bounds closed, EXPIRED on a 404 — and a FAILED one stays FAILED.

    it.each(['PENDING', 'SUBMITTED', 'FAILED'] as const)(
      'refuses a %s row whose envelope time bounds have closed',
      async (status) => {
        const lapsed = envelope({
          maxTime: Math.floor(Date.now() / 1000) - 60,
        });
        // `expiresAt` still in the future: the envelope's own bound decides.
        const target = row({ status, txHash: lapsed.hash });
        const settlement = makeSettlement(target);

        const err = await refusal(
          relay.submit(target, USERNAME, lapsed.xdr, makeProfile(settlement)),
        );

        expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
        expect(err.message).toBe(EXPIRED);
        expect(settlement.markSubmitted).not.toHaveBeenCalled();
        expect(stellar.submitTransaction).not.toHaveBeenCalled();
        expect(settlement.status()).toBe(status);
        expect(settlement.epoch()).toBe(0);
      },
    );

    it('refuses a row whose expiresAt has passed', async () => {
      const lapsed = row({ expiresAt: new Date(Date.now() - 1_000) });
      const settlement = makeSettlement(lapsed);

      const err = await refusal(
        relay.submit(lapsed, USERNAME, SIGNED.xdr, makeProfile(settlement)),
      );

      expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(err.message).toBe(EXPIRED);
      expect(stellar.submitTransaction).not.toHaveBeenCalled();
    });

    it('still answers a retry of the settled envelope after it lapsed', async () => {
      // Settlement is final; its lifetime no longer matters to the answer.
      const settled = row({
        status: 'SUCCEEDED',
        expiresAt: new Date(Date.now() - 1_000),
      });

      const outcome = await relay.submit(
        settled,
        USERNAME,
        SIGNED.xdr,
        makeProfile(makeSettlement(settled)),
      );

      expect(outcome.status).toBe('SUCCEEDED');
    });
  });

  describe('resubmitting a rejected envelope is capped per row', () => {
    it('refuses a FAILED row that has used every resubmit', async () => {
      const exhausted = row({
        status: 'FAILED',
        settlementEpoch: SETTLEMENT_MAX_RESUBMITS,
      });
      const settlement = makeSettlement(exhausted);

      const err = await refusal(
        relay.submit(exhausted, USERNAME, SIGNED.xdr, makeProfile(settlement)),
      );

      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(err.message).toBe(RESUBMITS_EXHAUSTED);
      expect(settlement.markSubmitted).not.toHaveBeenCalled();
      expect(stellar.submitTransaction).not.toHaveBeenCalled();
    });

    it('refuses when a concurrent resubmit used the last one first', async () => {
      // Read below the cap; by the compare-and-swap another request had already
      // resubmitted, been rejected, and left the row FAILED at the cap.
      const stale = row({
        status: 'FAILED',
        settlementEpoch: SETTLEMENT_MAX_RESUBMITS - 1,
      });
      const settlement = makeSettlement(stale);
      settlement.force('FAILED', SETTLEMENT_MAX_RESUBMITS);

      const err = await refusal(
        relay.submit(stale, USERNAME, SIGNED.xdr, makeProfile(settlement)),
      );

      expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(err.message).toBe(RESUBMITS_EXHAUSTED);
      expect(stellar.submitTransaction).not.toHaveBeenCalled();
    });

    it('holds a caller looping on a rejected envelope to the cap', async () => {
      // The exploit: POST the same envelope again every time it is rejected.
      const settlement = makeSettlement(row());
      const profile = makeProfile(settlement);
      stellar.submitTransaction.mockRejectedValue(
        horizonReject({ transaction: 'tx_bad_auth' }),
      );

      // The first attempt and every resubmit the cap allows reach the network…
      for (let attempt = 0; attempt <= SETTLEMENT_MAX_RESUBMITS; attempt++) {
        const outcome = await relay.submit(
          settlement.read(),
          USERNAME,
          SIGNED.xdr,
          profile,
        );
        expect(outcome.status).toBe('FAILED');
      }
      // …and the next one does not.
      const err = await refusal(
        relay.submit(settlement.read(), USERNAME, SIGNED.xdr, profile),
      );

      expect(err.message).toBe(RESUBMITS_EXHAUSTED);
      expect(stellar.submitTransaction).toHaveBeenCalledTimes(
        SETTLEMENT_MAX_RESUBMITS + 1,
      );
      expect(settlement.epoch()).toBe(SETTLEMENT_MAX_RESUBMITS);
    });
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
    const profile = makeProfile(settlement);
    stellar.submitTransaction.mockRejectedValueOnce(
      new Error('socket hang up'),
    );

    const err = await refusal(
      relay.submit(pending, USERNAME, SIGNED.xdr, profile),
    );

    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.code).toBe(ApiErrorCode.ProviderUnavailable);
    expect(settlement.finalizeFailed).not.toHaveBeenCalled();
    expect(settlement.finalizeSucceeded).not.toHaveBeenCalled();
    expect(settlement.status()).toBe('SUBMITTED');

    // The retry the 503 asks for goes through, and does not spend a resubmit.
    const retried = await relay.submit(
      settlement.read(),
      USERNAME,
      SIGNED.xdr,
      profile,
    );
    expect(retried.status).toBe('SUCCEEDED');
    expect(settlement.epoch()).toBe(0);
  });
});
