import {
  Account,
  Address,
  Asset,
  FeeBumpTransaction,
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
import { ApiErrorCode } from '@/common/errors/api-error';
import {
  type BuiltEnvelopeLimits,
  builtEnvelopeRefused,
  checkBuiltEnvelope,
  type ExpectedDefindexCall,
  signedEnvelope,
  submittableUntil,
  transactionHash,
} from '@/native-plugins/defindex/defindex-envelope';
import { ApiError } from '@/common/errors/api-error';

const PASSPHRASE = Networks.TESTNET;
const caller = Keypair.random();
const CALLER = caller.publicKey();
const STRANGER = Keypair.random().publicKey();
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_VAULT = StrKey.encodeContract(Buffer.alloc(32, 8));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 9));
const OTHER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 10));

const AMOUNT = 10_000_000n;
const SLIPPAGE_BPS = 100;
const MIN = 9_900_000n; // AMOUNT less 1%

const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const vec = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
const amounts = (values: bigint[]) => vec(values.map(i128));
const address = (a: string) => new Address(a).toScVal();

/** `deposit(desired, min, from, invest)`, as a DeFindex vault takes it. */
function depositArgs({
  desired = [AMOUNT],
  min = [MIN],
  from = CALLER,
  invest = true,
}: {
  desired?: bigint[];
  min?: bigint[];
  from?: string;
  invest?: boolean;
} = {}): xdr.ScVal[] {
  return [
    amounts(desired),
    amounts(min),
    address(from),
    xdr.ScVal.scvBool(invest),
  ];
}

/** `withdraw(shares, min_amounts_out, from)`. */
function withdrawArgs({
  shares = 5_000n,
  min = [4_900n],
  from = CALLER,
}: { shares?: bigint; min?: bigint[]; from?: string } = {}): xdr.ScVal[] {
  return [i128(shares), amounts(min), address(from)];
}

function invocation(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
    subInvocations: subs,
  });
}

/** The vault pulling `amount` of `token` from the caller. */
const transfer = (
  amount = AMOUNT,
  { token = TOKEN, from = CALLER, to = VAULT } = {},
  subs: xdr.SorobanAuthorizedInvocation[] = [],
) =>
  invocation(
    token,
    'transfer',
    [address(from), address(to), i128(amount)],
    subs,
  );

const sourceAccountEntry = (root: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });

const addressEntry = (who: string, root: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(who).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });

interface Build {
  source?: string;
  contract?: string;
  fn?: string;
  args?: xdr.ScVal[];
  /** Default: the caller's one entry for exactly this call, with its transfer. */
  auth?: xdr.SorobanAuthorizationEntry[];
  resourceFee?: number;
  soroban?: boolean;
  timeout?: number;
  extraOp?: boolean;
  opSource?: string;
}

/** A deposit (or any call) as DeFindex hands it out: simulated and assembled. */
function build({
  source = CALLER,
  contract = VAULT,
  fn = 'deposit',
  args = depositArgs(),
  auth,
  resourceFee = 300_000,
  soroban = true,
  timeout = 300,
  extraOp = false,
  opSource,
}: Build = {}): Transaction {
  const entries = auth ?? [
    sourceAccountEntry(
      invocation(contract, fn, args, fn === 'deposit' ? [transfer()] : []),
    ),
  ];
  let builder = new TransactionBuilder(new Account(source, '41'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  }).addOperation(
    Operation.invokeContractFunction({
      contract,
      function: fn,
      args,
      auth: entries,
      ...(opSource ? { source: opSource } : {}),
    }),
  );
  if (extraOp) {
    builder = builder.addOperation(
      Operation.payment({
        destination: STRANGER,
        asset: Asset.native(),
        amount: '1',
      }),
    );
  }
  if (soroban) {
    builder = builder.setSorobanData(
      new SorobanDataBuilder().setResourceFee(resourceFee).build(),
    );
  }
  return builder.setTimeout(timeout).build();
}

/** The withdrawal DeFindex builds: no sub-invocation under the caller's auth. */
const buildWithdraw = (
  args = withdrawArgs(),
  auth?: xdr.SorobanAuthorizationEntry[],
) => build({ fn: 'withdraw', args, auth });

type Envelope = {
  v1: {
    tx: {
      fee: number;
      memo: unknown;
      cond: { type: string; timeBounds?: { minTime: bigint; maxTime: bigint } };
      ext: { sorobanData?: { resourceFee: bigint } };
    };
  };
  toXDR(format: 'base64'): string;
};

/** The envelope of `tx` with `change` applied: what no builder would produce. */
function tampered(tx: Transaction, change: (envelope: Envelope) => void) {
  const envelope = TransactionBuilder.fromXDR(
    tx.toXDR(),
    PASSPHRASE,
  ).toEnvelope() as unknown as Envelope;
  change(envelope);
  return envelope.toXDR('base64');
}

const DEPOSIT: ExpectedDefindexCall = {
  kind: 'deposit',
  vault: VAULT,
  caller: CALLER,
  amounts: [AMOUNT],
  invest: true,
  slippageBps: SLIPPAGE_BPS,
};
const WITHDRAW: ExpectedDefindexCall = {
  kind: 'withdraw',
  vault: VAULT,
  caller: CALLER,
  shares: 5_000n,
  slippageBps: SLIPPAGE_BPS,
};

const limits = (
  overrides: Partial<BuiltEnvelopeLimits> = {},
): BuiltEnvelopeLimits => ({
  maxFeeStroops: 10_000_000n,
  maxValidityMs: 15 * 60_000,
  clockSkewMs: 60_000,
  now: new Date(),
  ...overrides,
});

const check = (
  envelope: Transaction | string,
  expected: ExpectedDefindexCall = DEPOSIT,
  bounds: BuiltEnvelopeLimits = limits(),
) =>
  checkBuiltEnvelope(
    typeof envelope === 'string' ? envelope : envelope.toXDR(),
    PASSPHRASE,
    expected,
    bounds,
  );

const reasonOf = (...args: Parameters<typeof check>) => {
  const result = check(...args);
  return result.ok ? null : result.reason;
};

describe('checkBuiltEnvelope', () => {
  describe('accepts', () => {
    it('the deposit DeFindex builds: one call, the caller pulling the amount into the vault', () => {
      const tx = build();
      const result = check(tx);
      expect(result.ok).toBe(true);
      expect(result.ok && transactionHash(result.tx)).toBe(transactionHash(tx));
    });

    it('the share withdrawal DeFindex builds, with nothing under the caller authorization', () => {
      expect(reasonOf(buildWithdraw(), WITHDRAW)).toBeNull();
    });

    it('address credentials of the caller', () => {
      const args = depositArgs();
      const tx = build({
        args,
        auth: [
          addressEntry(
            CALLER,
            invocation(VAULT, 'deposit', args, [transfer()]),
          ),
        ],
      });
      expect(reasonOf(tx)).toBeNull();
    });

    it('minimums anywhere from the slippage floor (one unit of rounding below) to the amount', () => {
      for (const min of [MIN - 1n, MIN, AMOUNT]) {
        const args = depositArgs({ min: [min] });
        expect(reasonOf(build({ args }))).toBeNull();
      }
    });

    it('a deposit that pulls less than requested, one token per asset', () => {
      const desired = [AMOUNT, 2n * AMOUNT];
      const args = depositArgs({ desired, min: [MIN, 2n * MIN] });
      const tx = build({
        args,
        auth: [
          sourceAccountEntry(
            invocation(VAULT, 'deposit', args, [
              transfer(AMOUNT / 2n),
              transfer(AMOUNT, { token: OTHER_TOKEN }),
            ]),
          ),
        ],
      });
      expect(reasonOf(tx, { ...DEPOSIT, amounts: desired })).toBeNull();
    });
  });

  describe('refuses the envelope itself', () => {
    it('bytes that are no envelope', () => {
      expect(reasonOf('not-xdr')).toBe('it is not a transaction envelope');
    });

    it('a fee bump', () => {
      const inner = build();
      inner.sign(caller);
      const bump = TransactionBuilder.buildFeeBumpTransaction(
        Keypair.random(),
        '400000',
        inner,
        PASSPHRASE,
      );
      expect(reasonOf(bump.toXDR())).toBe('it is a fee bump');
    });

    it('another source', () => {
      expect(reasonOf(build({ source: STRANGER }))).toBe(
        'its source is not the caller',
      );
    });

    it('a memo', () => {
      const envelope = tampered(build(), (e) => {
        e.v1.tx.memo = xdr.Memo.memoText('pay me');
      });
      expect(reasonOf(envelope)).toBe('it carries a memo');
    });

    it('preconditions beyond time bounds', () => {
      const envelope = tampered(build(), (e) => {
        e.v1.tx.cond = xdr.Preconditions.precondV2(
          new xdr.PreconditionsV2({
            timeBounds: (e.v1.tx.cond.timeBounds ??
              null) as unknown as xdr.TimeBounds | null,
            ledgerBounds: null,
            minSeqNum: null,
            minSeqAge: 0n,
            minSeqLedgerGap: 0,
            extraSigners: [],
          }),
        );
      });
      expect(reasonOf(envelope)).toBe(
        'it carries preconditions beyond time bounds',
      );
    });
  });

  describe('refuses its time bounds', () => {
    it('none at all', () => {
      expect(reasonOf(build({ timeout: 0 }))).toBe(
        'it has no upper time bound',
      );
    });

    it('open longer than the cap', () => {
      expect(reasonOf(build({ timeout: 24 * 3600 }))).toBe(
        'its time bounds stay open too long',
      );
    });

    it('already closed', () => {
      const later = new Date(Date.now() + 10 * 60_000);
      expect(reasonOf(build(), DEPOSIT, limits({ now: later }))).toBe(
        'its time bounds already closed',
      );
    });

    it('not open yet', () => {
      const envelope = tampered(build(), (e) => {
        const bounds = e.v1.tx.cond.timeBounds!;
        bounds.minTime = bounds.maxTime - 1n;
      });
      expect(reasonOf(envelope)).toBe('it is not valid yet');
    });
  });

  describe('refuses its fees', () => {
    it('a fee above the configured cap', () => {
      const tx = build({ resourceFee: 10_000_000 }); // + 100 inclusion
      expect(reasonOf(tx)).toBe(`its fee ${tx.fee} exceeds 10000000 stroops`);
    });

    it('a resource fee above the fee it is part of', () => {
      const envelope = tampered(build(), (e) => {
        e.v1.tx.fee = 1000;
      });
      expect(reasonOf(envelope)).toBe(
        'its resource fee 300000 is not within its fee',
      );
    });

    it('no Soroban resources at all', () => {
      expect(reasonOf(build({ soroban: false }))).toBe(
        'it carries no Soroban resources',
      );
    });

    it('a lower cap when the operator sets one', () => {
      expect(
        reasonOf(build(), DEPOSIT, limits({ maxFeeStroops: 200_000n })),
      ).toMatch(/exceeds 200000 stroops/);
    });
  });

  describe('refuses its operation', () => {
    it('a second operation', () => {
      expect(reasonOf(build({ extraOp: true }))).toBe(
        'it does not make exactly one operation',
      );
    });

    it('an operation sourced by someone else', () => {
      expect(reasonOf(build({ opSource: STRANGER }))).toBe(
        'its operation has another source',
      );
    });

    it('another contract', () => {
      expect(reasonOf(build({ contract: OTHER_VAULT }))).toBe(
        'it calls another contract',
      );
    });

    it('another function', () => {
      expect(reasonOf(build({ fn: 'rescue' }))).toBe('it calls rescue');
    });
  });

  describe('refuses deposit arguments', () => {
    const cases: [string, xdr.ScVal[], string][] = [
      [
        'other amounts',
        depositArgs({ desired: [AMOUNT + 1n] }),
        'its deposit amounts differ from the request',
      ],
      [
        'a minimum below what slippageBps allows',
        depositArgs({ min: [MIN - 2n] }),
        'its minimum amount 1 is not what slippageBps 100 allows',
      ],
      [
        'a zero minimum',
        depositArgs({ min: [0n] }),
        'its minimum amount 1 is not what slippageBps 100 allows',
      ],
      [
        'a minimum above the amount',
        depositArgs({ min: [AMOUNT + 1n] }),
        'its minimum amount 1 is not what slippageBps 100 allows',
      ],
      [
        'a minimum per amount missing',
        depositArgs({ min: [] }),
        'its minimum amounts are not one per amount',
      ],
      [
        'another `from`',
        depositArgs({ from: STRANGER }),
        'its deposit is not from the caller',
      ],
      [
        'another invest flag',
        depositArgs({ invest: false }),
        'its invest flag differs from the request',
      ],
      [
        'minimums that are not i128',
        [
          amounts([AMOUNT]),
          vec([nativeToScVal(MIN, { type: 'u64' })]),
          address(CALLER),
          xdr.ScVal.scvBool(true),
        ],
        'its minimum amounts are not one per amount',
      ],
      [
        'a fifth argument',
        [...depositArgs(), xdr.ScVal.scvBool(true)],
        'its deposit does not take four arguments',
      ],
    ];
    for (const [label, args, reason] of cases) {
      it(label, () => {
        expect(reasonOf(build({ args }))).toBe(reason);
      });
    }

    it('a minimum the requested slippage would allow only at a wider setting', () => {
      // 1% asked, so 5% below the amount is refused even though it is >= 0.
      const args = depositArgs({ min: [(AMOUNT * 95n) / 100n] });
      expect(reasonOf(build({ args }))).toMatch(/slippageBps 100/);
      expect(
        reasonOf(build({ args }), { ...DEPOSIT, slippageBps: 500 }),
      ).toBeNull();
    });
  });

  describe('refuses withdrawal arguments', () => {
    const cases: [string, xdr.ScVal[], string][] = [
      [
        'other shares',
        withdrawArgs({ shares: 5_001n }),
        'its share count differs from the request',
      ],
      [
        'a negative minimum',
        withdrawArgs({ min: [-1n] }),
        'its minimum outputs are not one non-negative amount per vault asset',
      ],
      [
        'no minimum at all',
        withdrawArgs({ min: [] }),
        'its minimum outputs are not one non-negative amount per vault asset',
      ],
      [
        'more minimums than a vault has assets',
        withdrawArgs({ min: Array.from({ length: 17 }, () => 1n) }),
        'its minimum outputs are not one non-negative amount per vault asset',
      ],
      [
        'shares that are not i128',
        [
          nativeToScVal(5_000n, { type: 'u64' }),
          amounts([1n]),
          address(CALLER),
        ],
        'its share count differs from the request',
      ],
      [
        'another `from`',
        withdrawArgs({ from: STRANGER }),
        'its withdrawal is not from the caller',
      ],
    ];
    for (const [label, args, reason] of cases) {
      it(label, () => {
        expect(reasonOf(buildWithdraw(args), WITHDRAW)).toBe(reason);
      });
    }
  });

  describe('refuses its authorization', () => {
    const args = depositArgs();
    const root = (subs = [transfer()]) =>
      invocation(VAULT, 'deposit', args, subs);
    const refused = (auth: xdr.SorobanAuthorizationEntry[]) =>
      reasonOf(build({ args, auth }));

    it('no entry', () => {
      expect(refused([])).toBe('it carries 0 authorization entries, not one');
    });

    it('a second entry', () => {
      expect(
        refused([sourceAccountEntry(root()), sourceAccountEntry(root())]),
      ).toBe('it carries 2 authorization entries, not one');
    });

    it('address credentials of another address', () => {
      expect(refused([addressEntry(STRANGER, root())])).toBe(
        'its authorization is for another address',
      );
    });

    it('a root that is another call', () => {
      expect(
        refused([
          sourceAccountEntry(
            invocation(TOKEN, 'transfer', [
              address(CALLER),
              address(STRANGER),
              i128(AMOUNT),
            ]),
          ),
        ]),
      ).toBe('its authorization is not for the requested call');
    });

    it('a root with other arguments than the operation', () => {
      expect(
        refused([
          sourceAccountEntry(
            invocation(VAULT, 'deposit', depositArgs({ min: [AMOUNT] }), [
              transfer(),
            ]),
          ),
        ]),
      ).toBe('its authorization is not for the requested call');
    });

    it('a transfer to someone other than the vault', () => {
      expect(
        refused([
          sourceAccountEntry(root([transfer(AMOUNT, { to: STRANGER })])),
        ]),
      ).toBe('its authorization covers a transfer the deposit did not ask for');
    });

    it('a transfer of more than was requested', () => {
      expect(refused([sourceAccountEntry(root([transfer(AMOUNT + 1n)]))])).toBe(
        'its authorization covers a transfer the deposit did not ask for',
      );
    });

    it("a transfer of the vault's own shares", () => {
      expect(
        refused([
          sourceAccountEntry(root([transfer(AMOUNT, { token: VAULT })])),
        ]),
      ).toBe('its authorization covers a transfer the deposit did not ask for');
    });

    it('two transfers of the same token', () => {
      const desired = [AMOUNT, AMOUNT];
      const twoArgs = depositArgs({ desired, min: [MIN, MIN] });
      const tx = build({
        args: twoArgs,
        auth: [
          sourceAccountEntry(
            invocation(VAULT, 'deposit', twoArgs, [transfer(), transfer()]),
          ),
        ],
      });
      expect(reasonOf(tx, { ...DEPOSIT, amounts: desired })).toBe(
        'its authorization covers a transfer the deposit did not ask for',
      );
    });

    it('more transfers than assets', () => {
      expect(
        refused([
          sourceAccountEntry(
            root([transfer(1n), transfer(1n, { token: OTHER_TOKEN })]),
          ),
        ]),
      ).toBe('its authorization covers more transfers than assets');
    });

    it('a call nested under the transfer', () => {
      expect(
        refused([
          sourceAccountEntry(
            root([
              transfer(AMOUNT, {}, [
                invocation(OTHER_TOKEN, 'transfer', [
                  address(CALLER),
                  address(STRANGER),
                  i128(AMOUNT),
                ]),
              ]),
            ]),
          ),
        ]),
      ).toBe('its authorization covers a call that is not a deposit transfer');
    });

    it('a sub-invocation that is not a transfer', () => {
      expect(
        refused([
          sourceAccountEntry(
            root([
              invocation(TOKEN, 'approve', [
                address(CALLER),
                address(STRANGER),
                i128(AMOUNT),
                xdr.ScVal.scvU32(100),
              ]),
            ]),
          ),
        ]),
      ).toBe('its authorization covers a call that is not a deposit transfer');
    });

    it('anything authorized under a withdrawal', () => {
      const wargs = withdrawArgs();
      const tx = buildWithdraw(wargs, [
        sourceAccountEntry(invocation(VAULT, 'withdraw', wargs, [transfer()])),
      ]);
      expect(reasonOf(tx, WITHDRAW)).toBe(
        'its authorization covers calls a withdrawal does not make',
      );
    });
  });

  it('answers a refusal as 502 provider_error naming the reason', () => {
    const error = builtEnvelopeRefused('deposit', 'it carries a memo');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.getStatus()).toBe(502);
    expect(error.code).toBe(ApiErrorCode.ProviderError);
    expect(error.message).toBe(
      'DeFindex built a transaction that is not the requested deposit: it carries a memo',
    );
  });

  it('hashes the same envelope differently under another network', () => {
    const tx = build();
    const mainnet = checkBuiltEnvelope(
      tx.toXDR(),
      Networks.PUBLIC,
      DEPOSIT,
      limits(),
    );
    // The call reads the same; what keeps the networks apart is the hash a
    // row stores, which covers the passphrase.
    expect(mainnet.ok && transactionHash(mainnet.tx)).not.toBe(
      transactionHash(tx),
    );
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

  const refusal = (fn: () => unknown): ApiError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

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
      '400000',
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
          args: depositArgs(),
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
