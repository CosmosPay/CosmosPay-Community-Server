import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  toEventSelector,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Abi,
  type Hex,
} from 'viem';
import { approveCalldata } from '@/evm/erc20';
import {
  InProcessEvm,
  addressOf,
  compileContract,
  type CompiledContract,
  type DeployedContract,
} from '@/evm/in-process-evm.harness-spec';
import { P2P_MARKET_ARTIFACT } from '@/evm/p2p-market.artifact';
import {
  decodeBool,
  decodeChainOrder,
  decodeMatcherTerms,
  decodeP2pMarketLog,
  decodeUint,
  P2P_EVENT_TOPICS,
  P2P_MARKET_EVENTS,
  P2P_MARKET_FUNCTIONS,
  p2pCalldata,
  p2pMarketInitCode,
  p2pRevertName,
  p2pSelector,
  type P2pMarketFunction,
  type P2pOpenParams,
} from '@/p2p/p2p-market-abi';

/**
 * The hand-written P2PMarket codec, checked two ways: against viem's encoder
 * over the compiled ABI (every selector, topic and argument layout), and
 * against the contract itself in the in-process EVM, where an order opened
 * with OUR calldata must emit logs OUR decoder reads back field by field.
 */
jest.setTimeout(120_000);

const U = 1_000_000n;
const OWNER = addressOf('owner');
const TREASURY = addressOf('treasury');
const ARBITER = addressOf('arbiter');
const MATCHER = addressOf('matcher');
const MERCHANT = addressOf('merchant');
const BUYER = addressOf('buyer');
const USER = addressOf('user');
const INTEGRATOR = addressOf('integrator');
const BOT = addressOf('bot');

let MARKET: CompiledContract;
let TOKEN: CompiledContract;
let abi: Abi;

beforeAll(() => {
  MARKET = compileContract('P2PMarket.sol', 'P2PMarket');
  TOKEN = compileContract('test/P2PTestToken.sol', 'P2PTestToken');
  abi = MARKET.abi;
});

const ref = (label: string): Hex => keccak256(toHex(label));

function params(overrides: Partial<P2pOpenParams> = {}): P2pOpenParams {
  return {
    ref: ref('order-1'),
    seller: MERCHANT,
    buyer: BUYER,
    token: addressOf('token'),
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

const viemCall = (functionName: string, args: readonly unknown[] = []) =>
  encodeFunctionData({ abi, functionName, args });

describe('P2PMarket codec against viem', () => {
  it('has the selector viem computes for every function', () => {
    for (const [name, signature] of Object.entries(P2P_MARKET_FUNCTIONS)) {
      expect(p2pSelector(name as P2pMarketFunction)).toBe(
        toFunctionSelector(signature),
      );
    }
  });

  it('names only functions the compiled ABI declares', () => {
    const declared = new Set<string>(
      abi
        .filter((item) => item.type === 'function')
        .map((item) => toFunctionSelector(item as never)),
    );
    for (const name of Object.keys(P2P_MARKET_FUNCTIONS)) {
      expect(declared.has(p2pSelector(name as P2pMarketFunction))).toBe(true);
    }
  });

  it('has the topic viem computes for every event, and each is in the ABI', () => {
    const declared = new Set(
      abi
        .filter((item) => item.type === 'event')
        .map((item) => toEventSelector(item as never)),
    );
    for (const [name, signature] of Object.entries(P2P_MARKET_EVENTS)) {
      const topic = P2P_EVENT_TOPICS[name as keyof typeof P2P_MARKET_EVENTS];
      expect(topic).toBe(toEventSelector(signature));
      expect(declared.has(topic as Hex)).toBe(true);
    }
  });

  it('encodes open and openWithDeposit as viem does', () => {
    const p = params({
      bond: 10n * U,
      acceptWindow: 300,
      settleWindow: 3600,
      integrator: INTEGRATOR,
      integratorFeeBps: 50,
    });
    expect(p2pCalldata.open(p)).toBe(viemCall('open', [p]));
    expect(p2pCalldata.openWithDeposit(p)).toBe(
      viemCall('openWithDeposit', [p]),
    );
  });

  it('encodes every other call as viem does', () => {
    const t = addressOf('token');
    const cases: [string, string, readonly unknown[]][] = [
      [p2pCalldata.deposit(t, 5n * U), 'deposit', [t, 5n * U]],
      [p2pCalldata.withdraw(t, 7n), 'withdraw', [t, 7n]],
      [
        p2pCalldata.withdrawFor(MERCHANT, t, 9n),
        'withdrawFor',
        [MERCHANT, t, 9n],
      ],
      [p2pCalldata.setOperator(BOT, 6), 'setOperator', [BOT, 6]],
      [
        p2pCalldata.setMatcher(MATCHER, 500n * U, true),
        'setMatcher',
        [MATCHER, 500n * U, true],
      ],
      [p2pCalldata.orderAction('accept', 3n), 'accept', [3n]],
      [p2pCalldata.orderAction('markPaid', 3n), 'markPaid', [3n]],
      [p2pCalldata.orderAction('release', 3n), 'release', [3n]],
      [p2pCalldata.orderAction('settle', 3n), 'settle', [3n]],
      [p2pCalldata.orderAction('cancel', 3n), 'cancel', [3n]],
      [p2pCalldata.orderAction('dispute', 3n), 'dispute', [3n]],
      [p2pCalldata.resolve(3n, 40n, 2n), 'resolve', [3n, 40n, 2n]],
      [p2pCalldata.getOrder(12n), 'getOrder', [12n]],
      [
        p2pCalldata.orderIdOf(MATCHER, ref('x')),
        'orderIdOf',
        [MATCHER, ref('x')],
      ],
      [p2pCalldata.balanceOf(MERCHANT, t), 'balanceOf', [MERCHANT, t]],
      [
        p2pCalldata.permissionsOf(MERCHANT, BOT),
        'permissionsOf',
        [MERCHANT, BOT],
      ],
      [
        p2pCalldata.matcherTermsOf(MERCHANT, MATCHER),
        'matcherTermsOf',
        [MERCHANT, MATCHER],
      ],
      [p2pCalldata.tokenAllowed(t), 'tokenAllowed', [t]],
      [p2pCalldata.protocolFeeBps(), 'protocolFeeBps', []],
      [p2pCalldata.paused(), 'paused', []],
      [p2pCalldata.owner(), 'owner', []],
      [p2pCalldata.arbiter(), 'arbiter', []],
      [p2pCalldata.treasury(), 'treasury', []],
    ];
    for (const [ours, name, args] of cases) {
      expect(ours).toBe(viemCall(name, args));
    }
  });

  it('refuses values the contract types cannot carry', () => {
    expect(() => p2pCalldata.open(params({ amount: 1n << 128n }))).toThrow(
      'uint128',
    );
    expect(() =>
      p2pCalldata.open(params({ integratorFeeBps: 70_000 })),
    ).toThrow('uint16');
    expect(() => p2pCalldata.deposit('0x1234', 1n)).toThrow('EVM address');
    expect(() => p2pCalldata.open(params({ ref: '0x12' }))).toThrow('32 bytes');
  });

  it('decodes logs viem encodes, and refuses a log with the wrong shape', () => {
    const topics = encodeEventTopics({
      abi,
      eventName: 'OrderOpened',
      args: { id: 7n, opener: MATCHER, ref: ref('r') },
    }) as string[];
    const data = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'bool' },
      ],
      [MERCHANT, BUYER, addressOf('token'), 5n, 1n, true],
    );
    expect(decodeP2pMarketLog({ topics, data })).toEqual({
      name: 'OrderOpened',
      id: 7n,
      opener: MATCHER,
      ref: ref('r'),
      seller: MERCHANT,
      buyer: BUYER,
      token: addressOf('token'),
      amount: 5n,
      bond: 1n,
      viaMatcher: true,
    });
    expect(() =>
      decodeP2pMarketLog({ topics: topics.slice(0, 2), data }),
    ).toThrow('wrong shape');
    expect(
      decodeP2pMarketLog({ topics: [keccak256(toHex('Other()'))], data: '0x' }),
    ).toBeNull();
  });

  it('names the contract error a revert carries', () => {
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [1n, 2n],
    );
    const selector = toFunctionSelector('InsufficientBalance(uint256,uint256)');
    expect(p2pRevertName(`${selector}${data.slice(2)}`)).toBe(
      'InsufficientBalance',
    );
    expect(p2pRevertName(toFunctionSelector('NotAuthorized()'))).toBe(
      'NotAuthorized',
    );
    expect(p2pRevertName('0xdeadbeef')).toBeNull();
    expect(p2pRevertName(undefined)).toBeNull();
  });
});

describe('P2PMarket codec against the contract', () => {
  let evm: InProcessEvm;
  let market: DeployedContract;
  let token: DeployedContract;

  beforeEach(async () => {
    evm = await InProcessEvm.create();
    token = await evm.deploy(OWNER, TOKEN);
    market = await evm.deploy(OWNER, MARKET, [OWNER, TREASURY, ARBITER, 100]);
    await market.must(OWNER, 'setToken', [token.address, true]);
  });

  async function raw(from: Hex, data: string) {
    const result = await evm.callRaw(from, market.address, data as Hex);
    expect(result.ok).toBe(true);
    return result;
  }

  async function fund(account: Hex, amount: bigint) {
    await token.must(OWNER, 'mint', [account, amount]);
    // Our approve calldata, sent to the token.
    const approved = await evm.callRaw(
      account,
      token.address,
      approveCalldata(market.address, amount) as Hex,
    );
    expect(approved.ok).toBe(true);
  }

  it('opens an order with our calldata and reads it back with our decoders', async () => {
    await fund(MERCHANT, 1_000n * U);
    await raw(MERCHANT, p2pCalldata.deposit(token.address, 1_000n * U));
    const terms = await raw(
      MERCHANT,
      p2pCalldata.setMatcher(MATCHER, 500n * U, false),
    );
    expect(decodeP2pMarketLog(terms.logs[0])).toEqual({
      name: 'MatcherSet',
      seller: MERCHANT,
      matcher: MATCHER,
      maxPerOrder: 500n * U,
      autoSettle: false,
    });
    expect(
      decodeMatcherTerms(
        (await raw(MATCHER, p2pCalldata.matcherTermsOf(MERCHANT, MATCHER)))
          .returned,
      ),
    ).toEqual({ maxPerOrder: 500n * U, autoSettle: false });

    const p = params({
      token: token.address,
      integrator: INTEGRATOR,
      integratorFeeBps: 50,
    });
    const opened = await raw(MATCHER, p2pCalldata.open(p));
    const events = opened.logs.map((log) => decodeP2pMarketLog(log));
    expect(events[0]).toEqual({
      name: 'OrderOpened',
      id: 1n,
      opener: MATCHER,
      ref: p.ref,
      seller: MERCHANT,
      buyer: BUYER,
      token: token.address,
      amount: 100n * U,
      bond: 0n,
      viaMatcher: true,
    });
    expect(events[1]).toEqual({
      name: 'OrderAccepted',
      id: 1n,
      paymentDeadline: Number(evm.now) + 1800,
    });

    const order = decodeChainOrder(
      (await raw(MATCHER, p2pCalldata.getOrder(1n))).returned,
    );
    // viem decodes the same answer; the two must agree field by field.
    const viemOrder = decodeFunctionResult({
      abi,
      functionName: 'getOrder',
      data: (await raw(MATCHER, p2pCalldata.getOrder(1n))).returned,
    }) as Record<string, unknown>;
    expect(order).toMatchObject({
      seller: viemOrder.seller,
      buyer: viemOrder.buyer,
      token: viemOrder.token,
      opener: viemOrder.opener,
      integrator: viemOrder.integrator,
      amount: viemOrder.amount,
      bond: viemOrder.bond,
      feeBps: viemOrder.feeBps,
      integratorFeeBps: viemOrder.integratorFeeBps,
      paymentDeadline: viemOrder.paymentDeadline,
      paymentWindow: viemOrder.paymentWindow,
      settleWindow: viemOrder.settleWindow,
      viaMatcher: viemOrder.viaMatcher,
      fromBalance: viemOrder.fromBalance,
      ref: viemOrder.ref,
      status: 'Active',
    });
    expect(
      decodeUint(
        (await raw(MATCHER, p2pCalldata.orderIdOf(MATCHER, p.ref))).returned,
      ),
    ).toBe(1n);
    expect(
      decodeUint(
        (await raw(MATCHER, p2pCalldata.balanceOf(MERCHANT, token.address)))
          .returned,
      ),
    ).toBe(900n * U);

    // The rest of the life cycle, through our calldata and our decoder.
    const paid = await raw(MATCHER, p2pCalldata.orderAction('markPaid', 1n));
    expect(decodeP2pMarketLog(paid.logs[0])).toEqual({
      name: 'OrderPaid',
      id: 1n,
      by: MATCHER,
    });
    const released = await raw(
      MERCHANT,
      p2pCalldata.orderAction('release', 1n),
    );
    const releasedEvent = released.logs
      .map((log) => decodeP2pMarketLog(log))
      .find((e) => e?.name === 'OrderReleased');
    expect(releasedEvent).toEqual({
      name: 'OrderReleased',
      id: 1n,
      by: MERCHANT,
      toBuyer: 100n * U - 1n * U - U / 2n,
      protocolFee: 1n * U,
      integratorFee: U / 2n,
    });
  });

  it('decodes a sale opened with a deposit, accepted, disputed and resolved', async () => {
    await fund(USER, 200n * U);
    const p = params({
      ref: ref('sell'),
      seller: USER,
      buyer: MERCHANT,
      token: token.address,
      amount: 200n * U,
      bond: 20n * U,
      acceptWindow: 300,
      settleWindow: 3600,
    });
    const opened = await raw(USER, p2pCalldata.openWithDeposit(p));
    // The token's own Transfer log comes first; only the market's are ours.
    expect(
      opened.logs
        .filter((l) => l.address === market.address)
        .map((l) => decodeP2pMarketLog(l)?.name),
    ).toEqual(['OrderOpened']);
    await fund(MERCHANT, 20n * U);
    await raw(MERCHANT, p2pCalldata.deposit(token.address, 20n * U));
    const accepted = await raw(MERCHANT, p2pCalldata.orderAction('accept', 1n));
    expect(decodeP2pMarketLog(accepted.logs[0])).toMatchObject({
      name: 'OrderAccepted',
      id: 1n,
    });
    await raw(MERCHANT, p2pCalldata.orderAction('markPaid', 1n));
    const disputed = await raw(USER, p2pCalldata.orderAction('dispute', 1n));
    expect(decodeP2pMarketLog(disputed.logs[0])).toEqual({
      name: 'OrderDisputed',
      id: 1n,
      by: USER,
    });
    const resolved = await raw(ARBITER, p2pCalldata.resolve(1n, 0n, 20n * U));
    const event = resolved.logs
      .map((l) => decodeP2pMarketLog(l))
      .find((e) => e?.name === 'OrderResolved');
    expect(event).toEqual({
      name: 'OrderResolved',
      id: 1n,
      toBuyer: 0n,
      toSeller: 200n * U,
      bondToSeller: 20n * U,
      protocolFee: 0n,
      integratorFee: 0n,
    });
    const order = decodeChainOrder(
      (await raw(USER, p2pCalldata.getOrder(1n))).returned,
    );
    expect(order.status).toBe('Resolved');
    expect(order.fromBalance).toBe(false);
  });

  it('reads the views a deployment check reads', async () => {
    expect(
      decodeBool(
        (await raw(OWNER, p2pCalldata.tokenAllowed(token.address))).returned,
      ),
    ).toBe(true);
    expect(
      decodeUint((await raw(OWNER, p2pCalldata.protocolFeeBps())).returned, 16),
    ).toBe(100n);
    expect(decodeBool((await raw(OWNER, p2pCalldata.paused())).returned)).toBe(
      false,
    );
    const perms = await raw(BOT, p2pCalldata.permissionsOf(MERCHANT, BOT));
    expect(decodeUint(perms.returned, 8)).toBe(0n);
    await raw(MERCHANT, p2pCalldata.setOperator(BOT, 6));
    expect(
      decodeUint(
        (await raw(BOT, p2pCalldata.permissionsOf(MERCHANT, BOT))).returned,
        8,
      ),
    ).toBe(6n);
  });

  it('builds init code whose creation answers the artifact runtime', () => {
    const init = p2pMarketInitCode(P2P_MARKET_ARTIFACT.bytecode, {
      owner: OWNER,
      treasury: TREASURY,
      arbiter: ARBITER,
      feeBps: 100,
    });
    expect(init).toBe(
      P2P_MARKET_ARTIFACT.bytecode +
        encodeAbiParameters(
          [
            { type: 'address' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint16' },
          ],
          [OWNER, TREASURY, ARBITER, 100],
        ).slice(2),
    );
  });
});
