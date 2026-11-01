import {
  Account,
  Address,
  Asset,
  FeeBumpTransaction,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  type ExpectedDefindexCall,
  signedEnvelope,
  submittableUntil,
  transactionHash,
  verifyBuiltEnvelope,
} from '@/native-plugins/defindex/defindex-envelope';

const PASSPHRASE = Networks.TESTNET;
const caller = Keypair.random();
const CALLER = caller.publicKey();
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_VAULT = StrKey.encodeContract(Buffer.alloc(32, 8));

const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const vec = (values: bigint[]) => xdr.ScVal.scvVec(values.map(i128));

interface Build {
  source?: string;
  contract?: string;
  fn?: string;
  args?: xdr.ScVal[];
  extraOp?: boolean;
  timeout?: number;
}

/** A vault call as DeFindex builds one: `deposit(desired, min, from, invest)`. */
function depositArgs(
  amounts: bigint[],
  from = CALLER,
  invest = true,
): xdr.ScVal[] {
  return [
    vec(amounts),
    vec(amounts.map((a) => (a * 99n) / 100n)),
    new Address(from).toScVal(),
    xdr.ScVal.scvBool(invest),
  ];
}

function build({
  source = CALLER,
  contract = VAULT,
  fn = 'deposit',
  args = depositArgs([10_000_000n]),
  extraOp = false,
  timeout = 300,
}: Build = {}) {
  const builder = new TransactionBuilder(new Account(source, '41'), {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  }).addOperation(
    Operation.invokeContractFunction({ contract, function: fn, args }),
  );
  if (extraOp) {
    builder.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    );
  }
  return builder.setTimeout(timeout).build();
}

const DEPOSIT: ExpectedDefindexCall = {
  kind: 'deposit',
  vault: VAULT,
  caller: CALLER,
  amounts: [10_000_000n],
  invest: true,
};
const WITHDRAW: ExpectedDefindexCall = {
  kind: 'withdraw',
  vault: VAULT,
  caller: CALLER,
  shares: 5_000n,
};

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('verifyBuiltEnvelope', () => {
  it('accepts the deposit that was asked for', () => {
    const tx = build();
    const verified = verifyBuiltEnvelope(tx.toXDR(), PASSPHRASE, DEPOSIT);
    expect(transactionHash(verified)).toBe(transactionHash(tx));
  });

  it('accepts the share withdrawal that was asked for', () => {
    const tx = build({
      fn: 'withdraw',
      args: [i128(5_000n), vec([0n]), new Address(CALLER).toScVal()],
    });
    expect(() =>
      verifyBuiltEnvelope(tx.toXDR(), PASSPHRASE, WITHDRAW),
    ).not.toThrow();
  });

  const wrong: [string, () => string][] = [
    [
      'another source',
      () => build({ source: Keypair.random().publicKey() }).toXDR(),
    ],
    ['another contract', () => build({ contract: OTHER_VAULT }).toXDR()],
    ['another function', () => build({ fn: 'rescue' }).toXDR()],
    ['a second operation', () => build({ extraOp: true }).toXDR()],
    [
      'other amounts',
      () => build({ args: depositArgs([10_000_001n]) }).toXDR(),
    ],
    [
      'another `from`',
      () =>
        build({
          args: depositArgs([10_000_000n], Keypair.random().publicKey()),
        }).toXDR(),
    ],
    [
      'another invest flag',
      () => build({ args: depositArgs([10_000_000n], CALLER, false) }).toXDR(),
    ],
    ['bytes that are no envelope', () => 'not-xdr'],
    [
      'a fee bump',
      () => {
        const inner = build();
        inner.sign(caller);
        return TransactionBuilder.buildFeeBumpTransaction(
          Keypair.random(),
          '200000',
          inner,
          PASSPHRASE,
        ).toXDR();
      },
    ],
  ];
  for (const [label, envelope] of wrong) {
    it(`refuses ${label} as 502 provider_error`, () => {
      const error = refusal(() =>
        verifyBuiltEnvelope(envelope(), PASSPHRASE, DEPOSIT),
      );
      expect(error.getStatus()).toBe(502);
      expect(error.code).toBe(ApiErrorCode.ProviderError);
    });
  }

  it('refuses a withdrawal of other shares', () => {
    const tx = build({
      fn: 'withdraw',
      args: [i128(5_001n), vec([0n]), new Address(CALLER).toScVal()],
    });
    expect(
      refusal(() => verifyBuiltEnvelope(tx.toXDR(), PASSPHRASE, WITHDRAW)).code,
    ).toBe(ApiErrorCode.ProviderError);
  });

  it('hashes the same envelope differently under another network', () => {
    const tx = build();
    // The call reads the same under mainnet's passphrase; what keeps the
    // networks apart is the hash a row stores, which covers the passphrase.
    const verified = verifyBuiltEnvelope(tx.toXDR(), Networks.PUBLIC, DEPOSIT);
    expect(transactionHash(verified)).not.toBe(transactionHash(tx));
  });
});

describe('signedEnvelope', () => {
  it('returns a signed transaction whose hash is the unsigned one', () => {
    const tx = build();
    const unsignedHash = transactionHash(tx);
    tx.sign(caller);
    const parsed = signedEnvelope(tx.toXDR(), PASSPHRASE);
    expect(parsed.signatures).toHaveLength(1);
    expect(transactionHash(parsed)).toBe(unsignedHash);
  });

  it('refuses an envelope with no signature (400 validation_failed)', () => {
    const error = refusal(() => signedEnvelope(build().toXDR(), PASSPHRASE));
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe(ApiErrorCode.ValidationFailed);
  });

  it('refuses bytes that are no envelope', () => {
    expect(refusal(() => signedEnvelope('AAAA', PASSPHRASE)).code).toBe(
      ApiErrorCode.ValidationFailed,
    );
  });

  it('refuses a fee bump, which hashes as itself', () => {
    const inner = build();
    inner.sign(caller);
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '200000',
      inner,
      PASSPHRASE,
    );
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(refusal(() => signedEnvelope(bump.toXDR(), PASSPHRASE)).code).toBe(
      ApiErrorCode.ValidationFailed,
    );
  });
});

describe('submittableUntil', () => {
  const builtAt = new Date('2026-11-01T12:00:00Z');
  const TTL = 15 * 60_000;

  /** A deposit whose envelope closes at `maxTime` (seconds; 0 is no upper bound). */
  const closingAt = (maxTime: number) =>
    new TransactionBuilder(new Account(CALLER, '1'), {
      fee: '100',
      networkPassphrase: PASSPHRASE,
      timebounds: { minTime: 0, maxTime },
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: VAULT,
          function: 'deposit',
          args: depositArgs([1n]),
        }),
      )
      .build();

  it('is the envelope maxTime when that closes first', () => {
    const tx = closingAt(builtAt.getTime() / 1000 + 300);
    expect(submittableUntil(tx, builtAt, TTL)).toEqual(
      new Date(builtAt.getTime() + 300_000),
    );
  });

  it('is the cap for an envelope with no upper bound', () => {
    expect(submittableUntil(closingAt(0), builtAt, TTL)).toEqual(
      new Date(builtAt.getTime() + TTL),
    );
  });

  it('is the cap for an envelope valid for longer', () => {
    const tx = closingAt(builtAt.getTime() / 1000 + 24 * 3600);
    expect(submittableUntil(tx, builtAt, TTL)).toEqual(
      new Date(builtAt.getTime() + TTL),
    );
  });
});
