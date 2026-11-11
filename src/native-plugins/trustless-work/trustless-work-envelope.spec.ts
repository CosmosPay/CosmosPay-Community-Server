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
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { BuiltEnvelopeLimits } from '@/stellar/soroban-envelope';
import {
  builtEnvelopeRefused,
  checkTrustlessWorkEnvelope,
  deployedContractId,
  type ExpectedContract,
  type ExpectedTrustlessWorkCall,
} from '@/native-plugins/trustless-work/trustless-work-envelope';

// ── Accounts and contracts ────────────────────────────────────────────────

const PASSPHRASE = Networks.TESTNET;
const PLATFORM = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const MERCHANT = Keypair.random().publicKey();
const RESOLVER = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const DEPLOYER = StrKey.encodeContract(Buffer.alloc(32, 1));
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 2));
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const TOKEN = new Asset(
  'USDC',
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
).contractId(PASSPHRASE);
const WASM = Buffer.alloc(32, 4);
const SALT = Buffer.alloc(32, 5);
const AMOUNT = 1_255_000_000n; // 125.5 USDC
const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';

// ── ScVal builders, the shapes `#[contracttype]` encodes ──────────────────

const str = (s: string) => xdr.ScVal.scvString(s);
const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const bool = (b: boolean) => xdr.ScVal.scvBool(b);
const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items);

/** A struct: an ScMap keyed by symbols, sorted as the host requires. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
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
}

const ROLES = {
  approver: BUYER,
  serviceProvider: MERCHANT,
  platform: PLATFORM,
  releaseSigner: BUYER,
  disputeResolver: RESOLVER,
  receiver: MERCHANT,
};

const EXPECTED: ExpectedContract = {
  engagementId: ID,
  title: 'Order #1042',
  description: 'Two chairs',
  roles: ROLES,
  amount: AMOUNT,
  platformFeeBps: 165,
  milestoneDescription: 'Order delivered',
  token: TOKEN,
};

interface ContractOverrides {
  roles?: Partial<typeof ROLES>;
  amount?: bigint;
  platformFee?: number;
  token?: string;
  flags?: Partial<Record<'disputed' | 'released' | 'resolved', boolean>>;
  milestones?: {
    description?: string;
    status?: string;
    evidence?: string;
    approved?: boolean;
  }[];
  receiverMemo?: number;
  engagementId?: string;
  extraField?: boolean;
}

/** The `Escrow` struct Trustless Work's deploy initializes the contract with. */
function contractVal(o: ContractOverrides = {}): xdr.ScVal {
  const roles = { ...ROLES, ...o.roles };
  const milestones = (o.milestones ?? [{}]).map((m) =>
    struct({
      approved: bool(m.approved ?? false),
      description: str(m.description ?? 'Order delivered'),
      evidence: str(m.evidence ?? ''),
      status: str(m.status ?? 'pending'),
    }),
  );
  return struct({
    amount: i128(o.amount ?? AMOUNT),
    description: str('Two chairs'),
    engagement_id: str(o.engagementId ?? ID),
    flags: struct({
      disputed: bool(o.flags?.disputed ?? false),
      released: bool(o.flags?.released ?? false),
      resolved: bool(o.flags?.resolved ?? false),
    }),
    milestones: vec(milestones),
    platform_fee: u32(o.platformFee ?? 165),
    receiver_memo: u32(o.receiverMemo ?? 0),
    roles: struct({
      approver: addr(roles.approver),
      dispute_resolver: addr(roles.disputeResolver),
      platform: addr(roles.platform),
      receiver: addr(roles.receiver),
      release_signer: addr(roles.releaseSigner),
      service_provider: addr(roles.serviceProvider),
    }),
    title: str('Order #1042'),
    trustline: struct({ address: addr(o.token ?? TOKEN) }),
    ...(o.extraField ? { extra: u32(1) } : {}),
  });
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

const sourceEntry = (root: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });

/** The token pulling the deposit from the buyer into the contract. */
const transfer = (
  amount = AMOUNT,
  { from = BUYER, to = CONTRACT, token = TOKEN } = {},
) => invocation(token, 'transfer', [addr(from), addr(to), i128(amount)]);

interface Build {
  source: string;
  contract: string;
  fn: string;
  args: xdr.ScVal[];
  /** Under the signer's root; default none (a fund passes its transfer). */
  subs?: xdr.SorobanAuthorizedInvocation[];
  auth?: xdr.SorobanAuthorizationEntry[];
}

/** An envelope as Trustless Work hands one out: simulated and assembled. */
function build({
  source,
  contract,
  fn,
  args,
  subs = [],
  auth,
}: Build): Transaction {
  return new TransactionBuilder(new Account(source, '41'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract,
        function: fn,
        args,
        auth: auth ?? [sourceEntry(invocation(contract, fn, args, subs))],
      }),
    )
    .setSorobanData(new SorobanDataBuilder().setResourceFee(500_000).build())
    .setTimeout(300)
    .build();
}

const deployArgs = ({
  signer = PLATFORM,
  wasm = WASM,
  salt = SALT,
  initFn = 'initialize_escrow',
  init = [contractVal()],
  ctor = [] as xdr.ScVal[],
} = {}) => [
  addr(signer),
  xdr.ScVal.scvBytes(wasm),
  xdr.ScVal.scvBytes(salt),
  xdr.ScVal.scvSymbol(initFn),
  vec(init),
  vec(ctor),
];

const deploy = (
  args = deployArgs(),
  subs: xdr.SorobanAuthorizedInvocation[] = [],
) =>
  build({
    source: PLATFORM,
    contract: DEPLOYER,
    fn: 'tw_new_single_release_escrow',
    args,
    subs,
  });

const fundArgs = ({
  signer = BUYER,
  contract = contractVal(),
  amount = AMOUNT,
} = {}) => [addr(signer), contract, i128(amount)];

const fund = (args = fundArgs(), subs = [transfer()]) =>
  build({ source: BUYER, contract: CONTRACT, fn: 'fund_escrow', args, subs });

const distributions = (entries: [string, bigint][]) =>
  xdr.ScVal.scvMap(
    entries.map(
      ([address, amount]) =>
        new xdr.ScMapEntry({ key: addr(address), val: i128(amount) }),
    ),
  );

const resolve = (entries: [string, bigint][]) =>
  build({
    source: RESOLVER,
    contract: CONTRACT,
    fn: 'resolve_dispute',
    args: [addr(RESOLVER), distributions(entries)],
  });

// ── What each build was asked for ─────────────────────────────────────────

const DEPLOY: ExpectedTrustlessWorkCall = {
  action: 'DEPLOY',
  signer: PLATFORM,
  contract: EXPECTED,
  pins: { deployer: '', wasmHash: '' },
};
const FUND: ExpectedTrustlessWorkCall = {
  action: 'FUND',
  signer: BUYER,
  contractId: CONTRACT,
  contract: EXPECTED,
  amount: AMOUNT,
};
const SHIP: ExpectedTrustlessWorkCall = {
  action: 'SHIP',
  signer: MERCHANT,
  contractId: CONTRACT,
  milestoneIndex: 0,
  status: 'shipped',
  evidence: 'DHL 123',
};
const RESOLVE: ExpectedTrustlessWorkCall = {
  action: 'RESOLVE',
  signer: RESOLVER,
  contractId: CONTRACT,
  distributions: [
    { address: BUYER, amount: 1_000_000_000n },
    { address: MERCHANT, amount: 255_000_000n },
  ],
  parties: { buyer: BUYER, merchant: MERCHANT },
  balance: AMOUNT,
};

const limits = (): BuiltEnvelopeLimits => ({
  maxFeeStroops: 20_000_000n,
  maxValidityMs: 15 * 60_000,
  clockSkewMs: 60_000,
  now: new Date(),
});

const check = (tx: Transaction, expected: ExpectedTrustlessWorkCall) =>
  checkTrustlessWorkEnvelope(tx.toXDR(), PASSPHRASE, expected, limits());

const reasonOf = (tx: Transaction, expected: ExpectedTrustlessWorkCall) => {
  const result = check(tx, expected);
  return result.ok ? null : result.reason;
};

describe('checkTrustlessWorkEnvelope', () => {
  describe('accepts what each action asked for', () => {
    it('a deploy, and derives the contract it creates from the deployer and the salt', () => {
      const result = check(deploy(), DEPLOY);
      expect(result.ok).toBe(true);
      expect(result.ok && result.deploy).toEqual({
        deployer: DEPLOYER,
        wasmHash: WASM.toString('hex'),
        contractId: deployedContractId(DEPLOYER, SALT, PASSPHRASE),
      });
    });

    it('a deploy whose milestone status Trustless Work spells its own way', () => {
      // The V1 docs say `peding` in one place and `pending` in another.
      const args = deployArgs({
        init: [contractVal({ milestones: [{ status: 'peding' }] })],
      });
      expect(reasonOf(deploy(args), DEPLOY)).toBeNull();
    });

    it('a deploy to the pinned deployer and wasm', () => {
      expect(
        reasonOf(deploy(), {
          ...DEPLOY,
          pins: { deployer: DEPLOYER, wasmHash: WASM.toString('hex') },
        }),
      ).toBeNull();
    });

    it('a fund with the token pulling the amount into the contract under it', () => {
      expect(reasonOf(fund(), FUND)).toBeNull();
    });

    it('a ship with the shipped status and the evidence', () => {
      const tx = build({
        source: MERCHANT,
        contract: CONTRACT,
        fn: 'change_milestone_status',
        args: [u32(0), str('shipped'), str('DHL 123'), addr(MERCHANT)],
      });
      expect(reasonOf(tx, SHIP)).toBeNull();
    });

    it('an approval, a release and a dispute by their signer', () => {
      const approve = build({
        source: BUYER,
        contract: CONTRACT,
        fn: 'approve_milestone',
        args: [u32(0), addr(BUYER)],
      });
      expect(
        reasonOf(approve, {
          action: 'APPROVE',
          signer: BUYER,
          contractId: CONTRACT,
          milestoneIndex: 0,
        }),
      ).toBeNull();
      const release = build({
        source: BUYER,
        contract: CONTRACT,
        fn: 'release_funds',
        args: [addr(BUYER)],
      });
      expect(
        reasonOf(release, {
          action: 'RELEASE',
          signer: BUYER,
          contractId: CONTRACT,
        }),
      ).toBeNull();
      const dispute = build({
        source: PLATFORM,
        contract: CONTRACT,
        fn: 'dispute_escrow',
        args: [addr(PLATFORM)],
      });
      expect(
        reasonOf(dispute, {
          action: 'DISPUTE',
          signer: PLATFORM,
          contractId: CONTRACT,
        }),
      ).toBeNull();
    });

    it('a resolution paying the decided split to the buyer and the merchant', () => {
      const tx = resolve([
        [BUYER, 1_000_000_000n],
        [MERCHANT, 255_000_000n],
      ]);
      expect(reasonOf(tx, RESOLVE)).toBeNull();
    });

    it('a resolution of the whole balance to one party, with no zero entry', () => {
      const tx = resolve([[BUYER, AMOUNT]]);
      expect(
        reasonOf(tx, {
          ...RESOLVE,
          distributions: [
            { address: BUYER, amount: AMOUNT },
            { address: MERCHANT, amount: 0n },
          ],
        }),
      ).toBeNull();
    });
  });

  describe('refuses a deploy', () => {
    const cases: [string, xdr.ScVal[], string][] = [
      [
        'that makes the merchant the approver (wrong roles in init_args)',
        deployArgs({ init: [contractVal({ roles: { approver: MERCHANT } })] }),
        'its initialized contract has another approver',
      ],
      [
        'that names a stranger as the receiver',
        deployArgs({ init: [contractVal({ roles: { receiver: STRANGER } })] }),
        'its initialized contract has another receiver',
      ],
      [
        'that makes the stranger the dispute resolver',
        deployArgs({
          init: [contractVal({ roles: { disputeResolver: STRANGER } })],
        }),
        'its initialized contract has another disputeResolver',
      ],
      [
        'with another amount',
        deployArgs({ init: [contractVal({ amount: AMOUNT + 1n })] }),
        'its initialized contract has another amount',
      ],
      [
        'with another platform fee',
        deployArgs({ init: [contractVal({ platformFee: 1 })] }),
        'its initialized contract has another platform fee',
      ],
      [
        'holding another token',
        deployArgs({ init: [contractVal({ token: OTHER_CONTRACT })] }),
        'its initialized contract holds another token',
      ],
      [
        'with a flag already set',
        deployArgs({ init: [contractVal({ flags: { released: true } })] }),
        'its initialized contract has a flag set',
      ],
      [
        'with a second milestone',
        deployArgs({ init: [contractVal({ milestones: [{}, {}] })] }),
        'its initialized contract does not have exactly one milestone',
      ],
      [
        'with an approved milestone',
        deployArgs({
          init: [contractVal({ milestones: [{ approved: true }] })],
        }),
        'its initialized contract has another milestone',
      ],
      [
        'with evidence already written',
        deployArgs({
          init: [contractVal({ milestones: [{ evidence: 'x' }] })],
        }),
        'its initialized contract has another milestone',
      ],
      [
        'with a status that is a payload, not a word',
        deployArgs({
          init: [contractVal({ milestones: [{ status: 'x'.repeat(33) }] })],
        }),
        'its initialized contract has another milestone',
      ],
      [
        'with a receiver memo',
        deployArgs({ init: [contractVal({ receiverMemo: 7 })] }),
        'its initialized contract sets a receiver memo',
      ],
      [
        'for another engagement',
        deployArgs({ init: [contractVal({ engagementId: 'other' })] }),
        'its initialized contract names another engagement id',
      ],
      [
        'whose struct has a field the contract does not',
        deployArgs({ init: [contractVal({ extraField: true })] }),
        'its initialized contract is not a single-release contract struct',
      ],
      [
        'signed by someone else',
        deployArgs({ signer: STRANGER }),
        'its deploy is not signed by the platform',
      ],
      [
        'with another init function',
        deployArgs({ initFn: 'update_escrow' }),
        'its init function is not initialize_escrow',
      ],
      [
        'with constructor arguments',
        deployArgs({ ctor: [u32(1)] }),
        'it passes constructor arguments',
      ],
      [
        'with two init arguments',
        deployArgs({ init: [contractVal(), contractVal()] }),
        'its init arguments are not the one contract struct',
      ],
      [
        'with a short wasm hash',
        deployArgs({ wasm: Buffer.alloc(31, 1) }),
        'its wasm hash is not 32 bytes',
      ],
    ];
    for (const [label, args, reason] of cases) {
      it(label, () => {
        expect(reasonOf(deploy(args), DEPLOY)).toBe(reason);
      });
    }

    it('to another deployer than the pinned one', () => {
      expect(
        reasonOf(deploy(), {
          ...DEPLOY,
          pins: { deployer: OTHER_CONTRACT, wasmHash: '' },
        }),
      ).toBe('it calls another deployer than the pinned one');
    });

    it('installing another wasm than the pinned one', () => {
      expect(
        reasonOf(deploy(), {
          ...DEPLOY,
          pins: { deployer: '', wasmHash: 'ab'.repeat(32) },
        }),
      ).toBe('it installs another wasm than the pinned one');
    });

    it('whose authorization covers a sub-invocation', () => {
      expect(reasonOf(deploy(deployArgs(), [transfer()]), DEPLOY)).toBe(
        'its authorization covers calls this action does not make',
      );
    });

    it('from another source than the platform', () => {
      const tx = build({
        source: STRANGER,
        contract: DEPLOYER,
        fn: 'tw_new_single_release_escrow',
        args: deployArgs(),
      });
      expect(reasonOf(tx, DEPLOY)).toBe('its source is not the caller');
    });
  });

  describe('refuses a fund', () => {
    it('whose expected_escrow differs from ours (another receiver)', () => {
      const args = fundArgs({
        contract: contractVal({ roles: { receiver: STRANGER } }),
      });
      expect(reasonOf(fund(args), FUND)).toBe(
        'its expected contract has another receiver',
      );
    });

    it('whose expected_escrow names another release signer', () => {
      const args = fundArgs({
        contract: contractVal({ roles: { releaseSigner: STRANGER } }),
      });
      expect(reasonOf(fund(args), FUND)).toBe(
        'its expected contract has another releaseSigner',
      );
    });

    it('of another amount', () => {
      const args = fundArgs({ amount: AMOUNT - 1n });
      expect(reasonOf(fund(args, [transfer(AMOUNT - 1n)]), FUND)).toBe(
        'its amount differs from the protected payment',
      );
    });

    it('from someone other than the buyer', () => {
      expect(reasonOf(fund(fundArgs({ signer: STRANGER })), FUND)).toBe(
        'its fund is not from the buyer',
      );
    });

    it('with an extra sub-invocation', () => {
      expect(
        reasonOf(
          fund(fundArgs(), [transfer(), transfer(1n, { to: STRANGER })]),
          FUND,
        ),
      ).toBe('its authorization does not cover exactly one transfer');
    });

    it('with no transfer under it', () => {
      expect(reasonOf(fund(fundArgs(), []), FUND)).toBe(
        'its authorization does not cover exactly one transfer',
      );
    });

    it('whose transfer pays someone else', () => {
      expect(
        reasonOf(fund(fundArgs(), [transfer(AMOUNT, { to: STRANGER })]), FUND),
      ).toBe('its authorization covers a transfer the fund did not ask for');
    });

    it('whose transfer is of another token', () => {
      expect(
        reasonOf(
          fund(fundArgs(), [transfer(AMOUNT, { token: OTHER_CONTRACT })]),
          FUND,
        ),
      ).toBe(
        'its authorization covers a call that is not the deposit transfer',
      );
    });

    it('whose transfer moves more than the amount', () => {
      expect(reasonOf(fund(fundArgs(), [transfer(AMOUNT + 1n)]), FUND)).toBe(
        'its authorization covers a transfer the fund did not ask for',
      );
    });

    it('to another contract', () => {
      const tx = build({
        source: BUYER,
        contract: OTHER_CONTRACT,
        fn: 'fund_escrow',
        args: fundArgs(),
        subs: [transfer()],
      });
      expect(reasonOf(tx, FUND)).toBe('it calls another contract');
    });

    it('that is another function', () => {
      const tx = build({
        source: BUYER,
        contract: CONTRACT,
        fn: 'update_escrow',
        args: fundArgs(),
      });
      expect(reasonOf(tx, FUND)).toBe('it calls update_escrow');
    });
  });

  describe('refuses a resolution', () => {
    it('that pays a third address', () => {
      const tx = resolve([
        [BUYER, 1_000_000_000n],
        [STRANGER, 255_000_000n],
      ]);
      expect(reasonOf(tx, RESOLVE)).toBe(
        'it pays an address that is neither the buyer nor the merchant',
      );
    });

    it('that does not add up to the balance', () => {
      const tx = resolve([
        [BUYER, 1_000_000_000n],
        [MERCHANT, 200_000_000n],
      ]);
      expect(
        reasonOf(tx, {
          ...RESOLVE,
          distributions: [
            { address: BUYER, amount: 1_000_000_000n },
            { address: MERCHANT, amount: 200_000_000n },
          ],
        }),
      ).toBe('its distributions do not add up to the balance');
    });

    it('that splits otherwise than decided', () => {
      const tx = resolve([
        [BUYER, 255_000_000n],
        [MERCHANT, 1_000_000_000n],
      ]);
      expect(reasonOf(tx, RESOLVE)).toBe(
        'its distributions differ from the decided split',
      );
    });

    it('with a zero distribution', () => {
      const tx = resolve([
        [BUYER, AMOUNT],
        [MERCHANT, 0n],
      ]);
      expect(reasonOf(tx, RESOLVE)).toBe(
        'it distributes a non-positive amount',
      );
    });

    it('signed by another resolver', () => {
      const tx = build({
        source: RESOLVER,
        contract: CONTRACT,
        fn: 'resolve_dispute',
        args: [addr(STRANGER), distributions([[BUYER, AMOUNT]])],
      });
      expect(reasonOf(tx, RESOLVE)).toBe('its resolver is not the signer');
    });
  });

  describe('refuses a ship, an approval, a release', () => {
    it('with other evidence than the request', () => {
      const tx = build({
        source: MERCHANT,
        contract: CONTRACT,
        fn: 'change_milestone_status',
        args: [u32(0), str('shipped'), str('UPS 999'), addr(MERCHANT)],
      });
      expect(reasonOf(tx, SHIP)).toBe(
        'it writes other evidence than the request',
      );
    });

    it('with no evidence at all (None)', () => {
      const tx = build({
        source: MERCHANT,
        contract: CONTRACT,
        fn: 'change_milestone_status',
        args: [u32(0), str('shipped'), xdr.ScVal.scvVoid(), addr(MERCHANT)],
      });
      expect(reasonOf(tx, SHIP)).toBe(
        'it writes other evidence than the request',
      );
    });

    it('approving another milestone', () => {
      const tx = build({
        source: BUYER,
        contract: CONTRACT,
        fn: 'approve_milestone',
        args: [u32(1), addr(BUYER)],
      });
      expect(
        reasonOf(tx, {
          action: 'APPROVE',
          signer: BUYER,
          contractId: CONTRACT,
          milestoneIndex: 0,
        }),
      ).toBe('it approves another milestone');
    });

    it('releasing for another signer', () => {
      const tx = build({
        source: BUYER,
        contract: CONTRACT,
        fn: 'release_funds',
        args: [addr(STRANGER)],
      });
      expect(
        reasonOf(tx, {
          action: 'RELEASE',
          signer: BUYER,
          contractId: CONTRACT,
        }),
      ).toBe('its address argument is not the signer');
    });
  });

  it('answers a refusal as 502 provider_error naming the action and the reason', () => {
    const error = builtEnvelopeRefused('FUND', 'it carries a memo');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.getStatus()).toBe(502);
    expect(error.code).toBe(ApiErrorCode.ProviderError);
    expect(error.message).toBe(
      'The protected-payments service built a transaction that is not the requested fund: it carries a memo',
    );
  });
});

describe('deployedContractId', () => {
  it('depends on the network, the deployer and the salt', () => {
    const id = deployedContractId(DEPLOYER, SALT, PASSPHRASE);
    expect(StrKey.isValidContract(id)).toBe(true);
    expect(deployedContractId(DEPLOYER, SALT, Networks.PUBLIC)).not.toBe(id);
    expect(deployedContractId(OTHER_CONTRACT, SALT, PASSPHRASE)).not.toBe(id);
    expect(
      deployedContractId(DEPLOYER, Buffer.alloc(32, 6), PASSPHRASE),
    ).not.toBe(id);
  });
});
