import {
  InProcessEvm,
  addressOf,
  compileContract,
  type CallResult,
  type CompiledContract,
  type DeployedContract,
} from '@/evm/in-process-evm.harness-spec';
import {
  encodeFunctionData,
  keccak256,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Hex,
} from 'viem';

/**
 * Runs contracts/P2PMarket.sol in an in-process EVM. Every rule its docblock
 * promises is pinned here: who may move which money, when, and that the
 * contract always holds exactly what its balances and live orders owe.
 */
jest.setTimeout(120_000);

const U = 1_000_000n; // one token, 6 decimals

enum Status {
  None,
  Offered,
  Active,
  Paid,
  Disputed,
  Released,
  Cancelled,
  Resolved,
}

const PERM_OPEN = 1;
const PERM_RELEASE = 2;
const PERM_TRADE = 4;
const PERM_WITHDRAW = 8;

const OWNER = addressOf('owner');
const TREASURY = addressOf('treasury');
const ARBITER = addressOf('arbiter');
const MATCHER = addressOf('matcher');
const MERCHANT = addressOf('merchant');
const BUYER = addressOf('buyer');
const USER = addressOf('user');
const INTEGRATOR = addressOf('integrator');
const STRANGER = addressOf('stranger');
const BOT = addressOf('bot');

const ref = (label: string): Hex => keccak256(toHex(label));

interface Order {
  seller: Hex;
  buyer: Hex;
  token: Hex;
  opener: Hex;
  integrator: Hex;
  status: number;
  fromBalance: boolean;
  viaMatcher: boolean;
  amount: bigint;
  bond: bigint;
  feeBps: number;
  integratorFeeBps: number;
  acceptDeadline: number;
  paymentDeadline: number;
  paidAt: number;
  paymentWindow: number;
  settleWindow: number;
  ref: Hex;
}

let MARKET: CompiledContract;
let TOKEN: CompiledContract;

beforeAll(() => {
  MARKET = compileContract('P2PMarket.sol', 'P2PMarket');
  TOKEN = compileContract('test/P2PTestToken.sol', 'P2PTestToken');
});

let evm: InProcessEvm;
let market: DeployedContract;
let token: DeployedContract;

beforeEach(async () => {
  evm = await InProcessEvm.create();
  token = await evm.deploy(OWNER, TOKEN);
  market = await evm.deploy(OWNER, MARKET, [OWNER, TREASURY, ARBITER, 100]);
  await market.must(OWNER, 'setToken', [token.address, true]);
});

// ---------------------------------------------------------------------------
// helpers

async function fund(account: Hex, amount: bigint): Promise<void> {
  await token.must(OWNER, 'mint', [account, amount]);
  await token.must(account, 'approve', [market.address, amount]);
}

async function depositAs(account: Hex, amount: bigint): Promise<void> {
  await fund(account, amount);
  await market.must(account, 'deposit', [token.address, amount]);
}

interface OpenParams {
  ref: Hex;
  seller: Hex;
  buyer: Hex;
  token: Hex;
  amount: bigint;
  bond: bigint;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  integrator: Hex;
  integratorFeeBps: number;
}

function params(overrides: Partial<OpenParams> = {}): OpenParams {
  return {
    ref: ref('order-1'),
    seller: MERCHANT,
    buyer: BUYER,
    token: token.address,
    amount: 100n * U,
    bond: 0n,
    acceptWindow: 0,
    paymentWindow: 1800,
    settleWindow: 0,
    integrator: zeroAddress,
    integratorFeeBps: 0,
    ...overrides,
  };
}

function openedId(result: CallResult): bigint {
  const log = result.logs.find((l) => l.eventName === 'OrderOpened');
  if (!log) throw new Error('no OrderOpened');
  return log.args.id as bigint;
}

async function order(id: bigint): Promise<Order> {
  return market.read<Order>('getOrder', [id]);
}

const balance = (account: Hex) =>
  market.read<bigint>('balanceOf', [account, token.address]);
const wallet = (account: Hex) => token.read<bigint>('balanceOf', [account]);

function expectRevert(result: CallResult, error: string): void {
  expect(result.ok).toBe(false);
  expect(result.error).toBe(error);
}

/** A merchant with liquidity, a matcher allowed up to `cap` per order. */
async function merchantWithMatcher(liquidity = 1_000n * U, cap = 500n * U) {
  await depositAs(MERCHANT, liquidity);
  await market.must(MERCHANT, 'setMatcher', [MATCHER, cap, false]);
}

/** A buy order the matcher opened on the merchant's liquidity. */
async function matchedBuy(overrides: Partial<OpenParams> = {}) {
  await merchantWithMatcher();
  const opened = await market.must(MATCHER, 'open', [params(overrides)]);
  return openedId(opened);
}

/** A sell order: USER locks tokens it sends now, MERCHANT must accept with a bond. */
async function bondedSell(overrides: Partial<OpenParams> = {}) {
  await fund(USER, 200n * U);
  const p = params({
    ref: ref('sell-1'),
    seller: USER,
    buyer: MERCHANT,
    amount: 200n * U,
    bond: 20n * U,
    acceptWindow: 600,
    settleWindow: 3600,
    ...overrides,
  });
  const opened = await market.must(USER, 'openWithDeposit', [p]);
  await depositAs(MERCHANT, 50n * U);
  return openedId(opened);
}

// ---------------------------------------------------------------------------

describe('P2PMarket: construction and administration', () => {
  it('refuses a zero owner, treasury or arbiter and a fee above the cap', async () => {
    for (const args of [
      [zeroAddress, TREASURY, ARBITER, 100],
      [OWNER, zeroAddress, ARBITER, 100],
      [OWNER, TREASURY, zeroAddress, 100],
    ]) {
      await expect(evm.deploy(OWNER, MARKET, args)).rejects.toThrow(
        'ZeroAddress',
      );
    }
    await expect(
      evm.deploy(OWNER, MARKET, [OWNER, TREASURY, ARBITER, 301]),
    ).rejects.toThrow('FeeTooHigh');
  });

  it('lets only the owner configure it, within the fee cap', async () => {
    expectRevert(
      await market.send(STRANGER, 'setProtocolFee', [50]),
      'NotOwner',
    );
    expectRevert(
      await market.send(STRANGER, 'setToken', [token.address, false]),
      'NotOwner',
    );
    expectRevert(
      await market.send(STRANGER, 'setArbiter', [STRANGER]),
      'NotOwner',
    );
    expectRevert(
      await market.send(STRANGER, 'setTreasury', [STRANGER]),
      'NotOwner',
    );
    expectRevert(await market.send(STRANGER, 'setPaused', [true]), 'NotOwner');
    expectRevert(
      await market.send(OWNER, 'setProtocolFee', [301]),
      'FeeTooHigh',
    );
    await market.must(OWNER, 'setProtocolFee', [300]);
    expect(await market.read('protocolFeeBps')).toBe(300);
  });

  it('transfers ownership in two steps', async () => {
    await market.must(OWNER, 'transferOwnership', [STRANGER]);
    expect(await market.read('owner')).toBe(OWNER);
    expectRevert(
      await market.send(BUYER, 'acceptOwnership'),
      'NotPendingOwner',
    );
    await market.must(STRANGER, 'acceptOwnership');
    expect(await market.read('owner')).toBe(STRANGER);
    expectRevert(
      await market.send(OWNER, 'setPaused', [true]),
      'NotOwner',
    );
  });
});

describe('P2PMarket: balances', () => {
  it('deposits and withdraws only to the owner of the balance', async () => {
    await depositAs(MERCHANT, 100n * U);
    expect(await balance(MERCHANT)).toBe(100n * U);
    expect(await wallet(market.address)).toBe(100n * U);

    expectRevert(
      await market.send(MERCHANT, 'withdraw', [token.address, 101n * U]),
      'InsufficientBalance',
    );
    await market.must(MERCHANT, 'withdraw', [token.address, 40n * U]);
    expect(await wallet(MERCHANT)).toBe(40n * U);
    expect(await balance(MERCHANT)).toBe(60n * U);
  });

  it('refuses a token the owner did not allow and a zero amount', async () => {
    const other = await evm.deploy(OWNER, TOKEN);
    expectRevert(
      await market.send(MERCHANT, 'deposit', [other.address, 1n]),
      'TokenNotAllowed',
    );
    expectRevert(
      await market.send(MERCHANT, 'deposit', [token.address, 0n]),
      'ZeroAmount',
    );
  });

  it('refuses a deposit that arrives short (fee on transfer)', async () => {
    await token.must(OWNER, 'setFeeBps', [100]);
    await fund(MERCHANT, 100n * U);
    expectRevert(
      await market.send(MERCHANT, 'deposit', [token.address, 100n * U]),
      'ShortDeposit',
    );
  });

  it('works with a token whose transfers return nothing', async () => {
    await token.must(OWNER, 'setNoReturn', [true]);
    await depositAs(MERCHANT, 10n * U);
    await market.must(MERCHANT, 'withdraw', [token.address, 10n * U]);
    expect(await wallet(MERCHANT)).toBe(10n * U);
  });

  it('lets a WITHDRAW operator withdraw, always to the account', async () => {
    await depositAs(MERCHANT, 10n * U);
    expectRevert(
      await market.send(BOT, 'withdrawFor', [MERCHANT, token.address, 1n]),
      'NotAuthorized',
    );
    await market.must(MERCHANT, 'setOperator', [BOT, PERM_TRADE]);
    expectRevert(
      await market.send(BOT, 'withdrawFor', [MERCHANT, token.address, 1n]),
      'NotAuthorized',
    );
    await market.must(MERCHANT, 'setOperator', [BOT, PERM_WITHDRAW]);
    await market.must(BOT, 'withdrawFor', [MERCHANT, token.address, 10n * U]);
    expect(await wallet(MERCHANT)).toBe(10n * U);
    expect(await wallet(BOT)).toBe(0n);
  });

  it('refuses unknown permission bits and self-delegation', async () => {
    expectRevert(
      await market.send(MERCHANT, 'setOperator', [BOT, 16]),
      'InvalidPermissions',
    );
    expectRevert(
      await market.send(MERCHANT, 'setOperator', [MERCHANT, 1]),
      'SameParty',
    );
    expectRevert(
      await market.send(MERCHANT, 'setMatcher', [MERCHANT, 1n, false]),
      'SameParty',
    );
  });
});

describe('P2PMarket: opening orders', () => {
  it('validates every parameter', async () => {
    await merchantWithMatcher();
    const cases: [Partial<OpenParams>, string][] = [
      [{ ref: `0x${'0'.repeat(64)}` }, 'EmptyRef'],
      [{ buyer: zeroAddress }, 'ZeroAddress'],
      [{ buyer: MERCHANT }, 'SameParty'],
      [{ amount: 0n }, 'ZeroAmount'],
      [{ paymentWindow: 299 }, 'BadWindow'],
      [{ paymentWindow: 2 * 86400 + 1 }, 'BadWindow'],
      [{ acceptWindow: 60 }, 'BadWindow'], // no bond, no acceptance step
      [{ bond: 1n, acceptWindow: 59 }, 'BadWindow'],
      [{ bond: 1n, acceptWindow: 86401 }, 'BadWindow'],
      [{ settleWindow: 3599 }, 'BadWindow'],
      [{ settleWindow: 14 * 86400 + 1 }, 'BadWindow'],
      [{ integrator: INTEGRATOR }, 'BadIntegrator'],
      [{ integratorFeeBps: 10 }, 'BadIntegrator'],
      [{ integrator: INTEGRATOR, integratorFeeBps: 501 }, 'FeeTooHigh'],
    ];
    for (const [overrides, error] of cases) {
      expectRevert(
        await market.send(MERCHANT, 'open', [params(overrides)]),
        error,
      );
    }
  });

  it('lets a matcher open only within its per-order cap, without a settle window unless allowed', async () => {
    await merchantWithMatcher(1_000n * U, 100n * U);
    expectRevert(
      await market.send(MATCHER, 'open', [params({ amount: 101n * U })]),
      'NotAuthorized',
    );
    expectRevert(
      await market.send(MATCHER, 'open', [params({ settleWindow: 3600 })]),
      'NotAuthorized',
    );
    expectRevert(
      await market.send(STRANGER, 'open', [params()]),
      'NotAuthorized',
    );

    const id = openedId(await market.must(MATCHER, 'open', [params()]));
    const o = await order(id);
    expect(o.status).toBe(Status.Active);
    expect(o.viaMatcher).toBe(true);
    expect(o.fromBalance).toBe(true);
    expect(o.opener).toBe(MATCHER);
    expect(o.feeBps).toBe(100);
    expect(o.paymentDeadline).toBe(Number(evm.now) + 1800);
    expect(await balance(MERCHANT)).toBe(900n * U);

    await market.must(MERCHANT, 'setMatcher', [MATCHER, 100n * U, true]);
    await market.must(MATCHER, 'open', [
      params({ ref: ref('auto'), settleWindow: 3600 }),
    ]);

    await market.must(MERCHANT, 'setMatcher', [MATCHER, 0n, true]);
    expect(
      await market.read('matcherTermsOf', [MERCHANT, MATCHER]),
    ).toEqual({ maxPerOrder: 0n, autoSettle: false });
    expectRevert(
      await market.send(MATCHER, 'open', [params({ ref: ref('after') })]),
      'NotAuthorized',
    );
  });

  it('lets the seller and an OPEN operator open on the balance, never past it', async () => {
    await depositAs(MERCHANT, 100n * U);
    expectRevert(
      await market.send(MERCHANT, 'open', [params({ amount: 101n * U })]),
      'InsufficientBalance',
    );
    const own = openedId(
      await market.must(MERCHANT, 'open', [params({ amount: 50n * U })]),
    );
    expect((await order(own)).viaMatcher).toBe(false);

    expectRevert(
      await market.send(BOT, 'open', [params({ ref: ref('bot') })]),
      'NotAuthorized',
    );
    await market.must(MERCHANT, 'setOperator', [BOT, PERM_OPEN]);
    const byBot = openedId(
      await market.must(BOT, 'open', [
        params({ ref: ref('bot'), amount: 50n * U, settleWindow: 3600 }),
      ]),
    );
    expect((await order(byBot)).opener).toBe(BOT);
    expect(await balance(MERCHANT)).toBe(0n);
  });

  it('keeps references unique per opener', async () => {
    await merchantWithMatcher();
    const id = openedId(await market.must(MATCHER, 'open', [params()]));
    expectRevert(await market.send(MATCHER, 'open', [params()]), 'RefTaken');
    expect(await market.read('orderIdOf', [MATCHER, ref('order-1')])).toBe(id);

    // another opener cannot take (or front-run) the matcher's reference
    const other = openedId(
      await market.must(MERCHANT, 'open', [params({ amount: 1n * U })]),
    );
    expect(other).not.toBe(id);
    expect(await market.read('orderIdOf', [MATCHER, ref('order-1')])).toBe(id);
    expect(await market.read('orderIdOf', [MERCHANT, ref('order-1')])).toBe(
      other,
    );
  });

  it('opens with a deposit only for the caller as seller', async () => {
    await fund(USER, 10n * U);
    expectRevert(
      await market.send(STRANGER, 'openWithDeposit', [
        params({ seller: USER, buyer: MERCHANT, amount: 10n * U }),
      ]),
      'NotAuthorized',
    );
    const id = openedId(
      await market.must(USER, 'openWithDeposit', [
        params({ seller: USER, buyer: MERCHANT, amount: 10n * U }),
      ]),
    );
    expect((await order(id)).fromBalance).toBe(false);
    expect(await wallet(USER)).toBe(0n);
    expect(await wallet(market.address)).toBe(10n * U);
  });
});

describe('P2PMarket: a buy on a merchant’s liquidity (no bond, seller releases)', () => {
  it('pays the buyer net of the protocol and integrator fees', async () => {
    const id = await matchedBuy({
      integrator: INTEGRATOR,
      integratorFeeBps: 50,
    });
    expectRevert(await market.send(STRANGER, 'markPaid', [id]), 'NotAuthorized');
    expectRevert(await market.send(MERCHANT, 'markPaid', [id]), 'NotAuthorized');
    // the matcher reports the payment for a buyer without gas
    await market.must(MATCHER, 'markPaid', [id]);
    expect((await order(id)).status).toBe(Status.Paid);

    expectRevert(await market.send(BUYER, 'release', [id]), 'NotAuthorized');
    expectRevert(await market.send(MATCHER, 'release', [id]), 'NotAuthorized');
    const released = await market.must(MERCHANT, 'release', [id]);
    const log = released.logs.find((l) => l.eventName === 'OrderReleased');
    expect(log?.args).toMatchObject({
      toBuyer: 985n * (U / 10n),
      protocolFee: 1n * U,
      integratorFee: U / 2n,
    });
    expect(await wallet(BUYER)).toBe(985n * (U / 10n));
    expect(await wallet(TREASURY)).toBe(1n * U);
    expect(await wallet(INTEGRATOR)).toBe(U / 2n);
    expect(await balance(MERCHANT)).toBe(900n * U);
    expect((await order(id)).status).toBe(Status.Released);
    expectRevert(await market.send(MERCHANT, 'release', [id]), 'WrongStatus');
  });

  it('keeps the fee an order was opened with', async () => {
    const id = await matchedBuy();
    await market.must(OWNER, 'setProtocolFee', [300]);
    await market.must(MERCHANT, 'release', [id]);
    expect(await wallet(TREASURY)).toBe(1n * U);
  });

  it('lets a RELEASE operator release, and no other permission', async () => {
    const id = await matchedBuy();
    await market.must(MERCHANT, 'setOperator', [
      BOT,
      PERM_TRADE | PERM_OPEN | PERM_WITHDRAW,
    ]);
    expectRevert(await market.send(BOT, 'release', [id]), 'NotAuthorized');
    await market.must(MERCHANT, 'setOperator', [BOT, PERM_RELEASE]);
    await market.must(BOT, 'release', [id]);
    expect(await wallet(BUYER)).toBe(99n * U);
  });

  it('expires an unpaid order back to the merchant, and only then lets anyone cancel it', async () => {
    const id = await matchedBuy();
    expectRevert(await market.send(STRANGER, 'cancel', [id]), 'NotAuthorized');
    expectRevert(await market.send(MERCHANT, 'cancel', [id]), 'NotAuthorized');
    evm.warp(1801);
    expectRevert(await market.send(MATCHER, 'markPaid', [id]), 'Expired');
    await market.must(STRANGER, 'cancel', [id]);
    expect((await order(id)).status).toBe(Status.Cancelled);
    expect(await balance(MERCHANT)).toBe(1_000n * U);
  });

  it('lets the buyer side cancel before paying', async () => {
    const id = await matchedBuy();
    await market.must(MATCHER, 'cancel', [id]);
    expect(await balance(MERCHANT)).toBe(1_000n * U);
  });

  it('never lets the seller or the matcher take back a paid order', async () => {
    const id = await matchedBuy();
    await market.must(MATCHER, 'markPaid', [id]);
    evm.warp(7 * 86400);
    expectRevert(await market.send(MERCHANT, 'cancel', [id]), 'NotAuthorized');
    expectRevert(await market.send(MATCHER, 'cancel', [id]), 'NotAuthorized');
    expectRevert(await market.send(STRANGER, 'cancel', [id]), 'NotAuthorized');
    expectRevert(await market.send(STRANGER, 'settle', [id]), 'NotYet');
    // the buyer itself may give up a payment it reported
    await market.must(BUYER, 'cancel', [id]);
    expect(await balance(MERCHANT)).toBe(1_000n * U);
  });

  it('sends a dispute to the arbiter, who pays only this order’s parties', async () => {
    const id = await matchedBuy();
    expectRevert(await market.send(BUYER, 'dispute', [id]), 'WrongStatus');
    await market.must(MATCHER, 'markPaid', [id]);
    expectRevert(await market.send(STRANGER, 'dispute', [id]), 'NotAuthorized');
    await market.must(MATCHER, 'dispute', [id]);
    expect((await order(id)).status).toBe(Status.Disputed);
    expectRevert(await market.send(MERCHANT, 'release', [id]), 'WrongStatus');

    expectRevert(
      await market.send(OWNER, 'resolve', [id, 60n * U, 0n]),
      'NotArbiter',
    );
    expectRevert(
      await market.send(ARBITER, 'resolve', [id, 101n * U, 0n]),
      'BadSplit',
    );
    expectRevert(
      await market.send(ARBITER, 'resolve', [id, 0n, 1n]),
      'BadSplit',
    );
    await market.must(ARBITER, 'resolve', [id, 60n * U, 0n]);
    expect(await wallet(BUYER)).toBe(594n * (U / 10n)); // 60 - 1%
    expect(await wallet(TREASURY)).toBe(6n * (U / 10n));
    expect(await balance(MERCHANT)).toBe(940n * U);
    expect((await order(id)).status).toBe(Status.Resolved);
    expectRevert(
      await market.send(ARBITER, 'resolve', [id, 0n, 0n]),
      'WrongStatus',
    );
  });

  it('credits a buyer the token refuses to pay, instead of freezing the order', async () => {
    const id = await matchedBuy();
    await token.must(OWNER, 'setBlocked', [BUYER, true]);
    const released = await market.must(MERCHANT, 'release', [id]);
    expect(released.logs.some((l) => l.eventName === 'Credited')).toBe(true);
    expect(await balance(BUYER)).toBe(99n * U);
    expect(await wallet(BUYER)).toBe(0n);
  });
});

describe('P2PMarket: a sell with a bond and a settle window', () => {
  it('needs the buyer to accept with its bond, then settles by itself after the window', async () => {
    const id = await bondedSell({
      integrator: INTEGRATOR,
      integratorFeeBps: 100,
    });
    expect((await order(id)).status).toBe(Status.Offered);
    expectRevert(await market.send(MERCHANT, 'markPaid', [id]), 'WrongStatus');
    expectRevert(await market.send(STRANGER, 'accept', [id]), 'NotAuthorized');

    await market.must(MERCHANT, 'accept', [id]);
    expect(await balance(MERCHANT)).toBe(30n * U);
    expect((await order(id)).status).toBe(Status.Active);

    await market.must(MERCHANT, 'markPaid', [id]);
    expectRevert(await market.send(STRANGER, 'settle', [id]), 'NotYet');
    evm.warp(3599);
    expectRevert(await market.send(STRANGER, 'settle', [id]), 'NotYet');
    evm.warp(1);
    await market.must(STRANGER, 'settle', [id]);

    // 200 - 1% protocol - 1% integrator to the merchant, its bond back
    expect(await wallet(MERCHANT)).toBe(196n * U);
    expect(await balance(MERCHANT)).toBe(50n * U);
    expect(await wallet(TREASURY)).toBe(2n * U);
    expect(await wallet(INTEGRATOR)).toBe(2n * U);
  });

  it('lets the seller dispute only inside the window', async () => {
    const id = await bondedSell();
    await market.must(MERCHANT, 'accept', [id]);
    await market.must(MERCHANT, 'markPaid', [id]);
    evm.warp(3600);
    expectRevert(await market.send(USER, 'dispute', [id]), 'Expired');

    const second = await bondedSell({ ref: ref('sell-2') });
    await market.must(MERCHANT, 'accept', [second]);
    await market.must(MERCHANT, 'markPaid', [second]);
    await market.must(USER, 'dispute', [second]);
    expectRevert(await market.send(STRANGER, 'settle', [second]), 'WrongStatus');
  });

  it('lets the arbiter give the seller the bond of a buyer that lied', async () => {
    const id = await bondedSell();
    await market.must(MERCHANT, 'accept', [id]);
    await market.must(MERCHANT, 'markPaid', [id]);
    await market.must(USER, 'dispute', [id]);
    await market.must(ARBITER, 'resolve', [id, 0n, 20n * U]);
    // the seller locked from its wallet, so its refund goes to its wallet
    expect(await wallet(USER)).toBe(220n * U);
    expect(await balance(MERCHANT)).toBe(30n * U);
    expect(await wallet(TREASURY)).toBe(0n);
  });

  it('returns part of the bond when the arbiter takes only part', async () => {
    const id = await bondedSell();
    await market.must(MERCHANT, 'accept', [id]);
    await market.must(MERCHANT, 'markPaid', [id]);
    await market.must(MERCHANT, 'dispute', [id]);
    await market.must(ARBITER, 'resolve', [id, 100n * U, 5n * U]);
    expect(await wallet(MERCHANT)).toBe(99n * U);
    expect(await wallet(USER)).toBe(105n * U);
    expect(await balance(MERCHANT)).toBe(45n * U);
  });

  it('expires an offer nobody accepted, and refuses a late acceptance', async () => {
    const id = await bondedSell();
    expectRevert(await market.send(STRANGER, 'cancel', [id]), 'NotAuthorized');
    evm.warp(601);
    expectRevert(await market.send(MERCHANT, 'accept', [id]), 'Expired');
    await market.must(STRANGER, 'cancel', [id]);
    expect(await wallet(USER)).toBe(200n * U);
    expect(await balance(MERCHANT)).toBe(50n * U);
  });

  it('lets the seller withdraw an offer before it is accepted', async () => {
    const id = await bondedSell();
    await market.must(USER, 'cancel', [id]);
    expect(await wallet(USER)).toBe(200n * U);
  });

  it('refuses an acceptance the buyer cannot bond', async () => {
    await fund(USER, 10n * U);
    const id = openedId(
      await market.must(USER, 'openWithDeposit', [
        params({
          seller: USER,
          buyer: BUYER,
          amount: 10n * U,
          bond: 5n * U,
          acceptWindow: 600,
        }),
      ]),
    );
    expectRevert(await market.send(BUYER, 'accept', [id]), 'InsufficientBalance');
  });

  it('returns the bond to a buyer that accepted and let the payment window pass', async () => {
    const id = await bondedSell();
    await market.must(MERCHANT, 'accept', [id]);
    evm.warp(1801);
    await market.must(STRANGER, 'cancel', [id]);
    expect(await wallet(USER)).toBe(200n * U);
    expect(await balance(MERCHANT)).toBe(50n * U);
  });
});

describe('P2PMarket: pause and reentrancy', () => {
  it('pauses new money in, never money out', async () => {
    const id = await matchedBuy();
    const second = openedId(
      await market.must(MATCHER, 'open', [params({ ref: ref('second') })]),
    );
    await market.must(MATCHER, 'markPaid', [second]);
    await market.must(OWNER, 'setPaused', [true]);

    expectRevert(
      await market.send(MERCHANT, 'deposit', [token.address, 1n]),
      'IsPaused',
    );
    expectRevert(
      await market.send(MATCHER, 'open', [params({ ref: ref('third') })]),
      'IsPaused',
    );
    await market.must(MERCHANT, 'release', [id]);
    await market.must(MATCHER, 'dispute', [second]);
    await market.must(ARBITER, 'resolve', [second, 0n, 0n]);
    await market.must(MERCHANT, 'withdraw', [token.address, 900n * U]);
    expect(await wallet(MERCHANT)).toBe(900n * U);
  });

  it('refuses a token that calls back into the market mid-transfer', async () => {
    const id = await matchedBuy();
    await token.must(OWNER, 'setHook', [
      market.address,
      encodeFunctionData({
        abi: MARKET.abi,
        functionName: 'cancel',
        args: [id],
      }),
    ]);
    await market.must(MERCHANT, 'release', [id]);
    expect(await token.read('hookRan')).toBe(true);
    expect(await token.read('hookOk')).toBe(false);
    expect(await token.read('hookResult')).toBe(
      toFunctionSelector('Reentrant()'),
    );
    expect((await order(id)).status).toBe(Status.Released);
  });
});

// ---------------------------------------------------------------------------
// Property test: random sequences of every action, from every actor. After
// each step the contract must hold exactly what it owes: every free balance,
// plus the amount of every live order, plus the bond of every accepted one.

describe('P2PMarket: random sequences never create or lose money', () => {
  const ACTORS = [MERCHANT, BUYER, USER, MATCHER, BOT, STRANGER, ARBITER];
  const ACCOUNTS = [...ACTORS, TREASURY, INTEGRATOR];
  const LIVE = new Set([
    Status.Offered,
    Status.Active,
    Status.Paid,
    Status.Disputed,
  ]);

  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function owed(ids: bigint[]): Promise<bigint> {
    let total = 0n;
    for (const a of ACCOUNTS) total += await balance(a);
    for (const id of ids) {
      const o = await order(id);
      if (!LIVE.has(o.status)) continue;
      total += o.amount;
      if (o.status !== Status.Offered) total += o.bond;
    }
    return total;
  }

  it.each([1, 2, 3, 4])('seed %i', async (seed) => {
    const rand = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const amount = () => BigInt(1 + Math.floor(rand() * 50)) * U;
    const ids: bigint[] = [];

    for (const a of [MERCHANT, BUYER, USER]) await depositAs(a, 500n * U);
    for (const a of [MERCHANT, USER]) await fund(a, 500n * U);
    await market.must(MERCHANT, 'setMatcher', [MATCHER, 40n * U, true]);
    await market.must(USER, 'setOperator', [BOT, 15]);

    for (let step = 0; step < 160; step++) {
      const from = pick(ACTORS);
      const id = ids.length > 0 ? pick(ids) : 0n;
      const roll = rand();
      if (roll < 0.2) {
        const seller = pick([MERCHANT, USER]);
        const p = params({
          ref: ref(`r${step}`),
          seller,
          buyer: pick(ACTORS.filter((a) => a !== seller)),
          amount: amount(),
          bond: rand() < 0.5 ? amount() / 4n : 0n,
          paymentWindow: 600,
          settleWindow: rand() < 0.5 ? 3600 : 0,
          integrator: rand() < 0.5 ? INTEGRATOR : zeroAddress,
        });
        p.acceptWindow = p.bond > 0n ? 300 : 0;
        p.integratorFeeBps = p.integrator === zeroAddress ? 0 : 75;
        const fn = rand() < 0.3 ? 'openWithDeposit' : 'open';
        const res = await market.send(fn === 'openWithDeposit' ? seller : from, fn, [p]);
        if (res.ok) ids.push(openedId(res));
      } else if (roll < 0.3) {
        await market.send(from, 'accept', [id]);
      } else if (roll < 0.42) {
        await market.send(from, 'markPaid', [id]);
      } else if (roll < 0.52) {
        await market.send(from, 'release', [id]);
      } else if (roll < 0.58) {
        await market.send(from, 'settle', [id]);
      } else if (roll < 0.68) {
        await market.send(from, 'cancel', [id]);
      } else if (roll < 0.74) {
        await market.send(from, 'dispute', [id]);
      } else if (roll < 0.8) {
        const o = await order(id);
        await market.send(ARBITER, 'resolve', [
          id,
          o.amount === 0n ? 0n : (o.amount * BigInt(Math.floor(rand() * 101))) / 100n,
          o.bond === 0n ? 0n : (o.bond * BigInt(Math.floor(rand() * 101))) / 100n,
        ]);
      } else if (roll < 0.86) {
        await market.send(from, 'withdraw', [token.address, amount()]);
      } else if (roll < 0.9) {
        await token.must(OWNER, 'setBlocked', [BUYER, rand() < 0.5]);
      } else {
        evm.warp(Math.floor(rand() * 4000));
      }

      const held = await wallet(market.address);
      expect(held).toBe(await owed(ids));
    }
    expect(ids.length).toBeGreaterThan(5);
  });
});
