import {
  Account,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { ApiError } from '@/common/errors/api-error';
import {
  hasLapsed,
  ledgerOutcome,
  resultCodes,
  verifySignedEnvelope,
} from '@/usdt0/usdt0-ledger';
import { USDT0_OFT } from '@/usdt0/usdt0.constants';

const holder = Keypair.random();

function unsignedTx(sequence = '41') {
  return new TransactionBuilder(new Account(holder.publicKey(), sequence), {
    fee: '100',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(new Contract(USDT0_OFT).call('send', xdr.ScVal.scvU32(1)))
    .setTimeout(300)
    .build();
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : 'not an ApiError';
  }
  return undefined;
}

describe('verifySignedEnvelope', () => {
  const built = unsignedTx();
  /** The same transaction, signed: rebuilding it could land in another second. */
  const signedCopy = () => {
    const copy = TransactionBuilder.fromXDR(
      built.toXDR(),
      Networks.PUBLIC,
    ) as typeof built;
    copy.sign(holder);
    return copy;
  };
  const expected = {
    txHash: Buffer.from(built.hash()).toString('hex'),
    passphrase: Networks.PUBLIC,
  };

  it('returns the envelope when it is the one built, signed', () => {
    const signed = signedCopy();
    const tx = verifySignedEnvelope(signed.toXDR(), expected);
    expect(Buffer.from(tx.hash()).toString('hex')).toBe(expected.txHash);
  });

  it('refuses bytes that are not an envelope', () => {
    expect(codeOf(() => verifySignedEnvelope('not-xdr', expected))).toBe(
      'validation_failed',
    );
  });

  it('refuses another transaction, signed or not', () => {
    const other = unsignedTx('99');
    other.sign(holder);
    expect(() => verifySignedEnvelope(other.toXDR(), expected)).toThrow(
      /does not match this transfer/,
    );
  });

  it('refuses the same transaction under the testnet passphrase', () => {
    const signed = signedCopy();
    expect(() =>
      verifySignedEnvelope(signed.toXDR(), {
        ...expected,
        passphrase: Networks.TESTNET,
      }),
    ).toThrow(/does not match/);
  });

  it('refuses the unsigned envelope the create response handed out', () => {
    expect(() => verifySignedEnvelope(built.toXDR(), expected)).toThrow(
      /carries no signatures/,
    );
  });
});

describe('hasLapsed', () => {
  const tx = unsignedTx();
  const maxTime = Number(tx.timeBounds!.maxTime) * 1000;

  it('is false inside the time bounds and true past them', () => {
    expect(hasLapsed(tx, new Date(maxTime), maxTime - 1000)).toBe(false);
    expect(hasLapsed(tx, new Date(maxTime), maxTime + 1000)).toBe(true);
  });

  it('also lapses at the stored expiry', () => {
    expect(hasLapsed(tx, new Date(maxTime - 5000), maxTime - 1000)).toBe(true);
  });
});

describe('resultCodes', () => {
  it('spells a failed invocation the way Horizon does', () => {
    const result = new xdr.TransactionResult({
      feeCharged: 100n,
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(
          xdr.OperationResultTr.invokeHostFunction(
            xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
          ),
        ),
      ]),
      ext: xdr.TransactionResultExt.v0(),
    });
    expect(resultCodes(result)).toEqual([
      'tx_failed',
      'invoke_host_function_trapped',
    ]);
  });

  it('reads a transaction-level refusal', () => {
    const result = new xdr.TransactionResult({
      feeCharged: 0n,
      result: xdr.TransactionResultResult.txBadAuth(),
      ext: xdr.TransactionResultExt.v0(),
    });
    expect(resultCodes(result)).toEqual(['tx_bad_auth']);
  });

  it('is empty without a result', () => {
    expect(resultCodes(undefined)).toEqual([]);
  });
});

describe('ledgerOutcome', () => {
  const base = {
    txHash: 'ab'.repeat(32),
    latestLedger: 2,
    latestLedgerCloseTime: 2,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
  };
  const struct = (fields: Record<string, xdr.ScVal>) =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map(
          (key) =>
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol(key),
              val: fields[key],
            }),
        ),
    );
  const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
  const sendReturn = xdr.ScVal.scvVec([
    struct({
      fee: struct({ native_fee: i128(5n), zro_fee: i128(0n) }),
      guid: xdr.ScVal.scvBytes(Buffer.alloc(32, 0xab)),
      nonce: nativeToScVal(7n, { type: 'u64' }),
    }),
    struct({ amount_received_ld: i128(10n), amount_sent_ld: i128(10n) }),
  ]);

  it('reads the guid of a successful send', () => {
    const outcome = ledgerOutcome({
      ...base,
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: sendReturn,
    } as unknown as rpc.Api.GetTransactionResponse);
    expect(outcome).toEqual({
      kind: 'succeeded',
      receipt: expect.objectContaining({
        guid: `0x${'ab'.repeat(32)}`,
        nonce: 7n,
      }),
    });
  });

  it('keeps a success whose return value cannot be read, without a receipt', () => {
    const outcome = ledgerOutcome({
      ...base,
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: xdr.ScVal.scvVoid(),
    } as unknown as rpc.Api.GetTransactionResponse);
    expect(outcome).toEqual({ kind: 'succeeded', receipt: null });
  });

  it('reads the codes of a failed one', () => {
    const outcome = ledgerOutcome({
      ...base,
      status: rpc.Api.GetTransactionStatus.FAILED,
      resultXdr: new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txFailed([
          xdr.OperationResult.opInner(
            xdr.OperationResultTr.invokeHostFunction(
              xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
            ),
          ),
        ]),
        ext: xdr.TransactionResultExt.v0(),
      }),
    } as unknown as rpc.Api.GetTransactionResponse);
    expect(outcome).toEqual({
      kind: 'failed',
      codes: ['tx_failed', 'invoke_host_function_trapped'],
    });
  });

  it('is absent when the ledger has no such transaction', () => {
    expect(
      ledgerOutcome({
        ...base,
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      }),
    ).toEqual({ kind: 'absent' });
  });
});
