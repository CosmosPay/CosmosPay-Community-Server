import { keccak_256 } from '@noble/hashes/sha3.js';
import { toChecksumAddress } from '@/chains/chain-address';
import { bytesToHex } from '@/evm/rlp';

/**
 * `contracts/P2PMarket.sol` as this service speaks it: calldata for every
 * function the API builds or the matcher sends, the views it reads, and the
 * events the indexer decodes. Encoded by hand (the contract's types are all
 * static, so every argument is one 32-byte word and no offsets are needed);
 * `p2p-market-abi.spec.ts` checks each encoder and decoder against viem and
 * against the real contract in the in-process EVM.
 *
 * Selectors and topics are computed from the signatures, never pasted: a typo
 * in a signature fails the spec instead of shipping a constant nobody can read.
 */

const UINT_MAX = (bits: number) => (1n << BigInt(bits)) - 1n;

/** keccak-256 of a UTF-8 string, 0x-hex. */
export function keccakText(text: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(text)));
}

/** The 4-byte selector of a function signature. */
export function functionSelector(signature: string): string {
  return keccakText(signature).slice(0, 10);
}

// --- words ---------------------------------------------------------------

function uintWord(value: bigint, bits = 256): string {
  if (value < 0n || value > UINT_MAX(bits)) {
    throw new RangeError(`${value} does not fit uint${bits}`);
  }
  return value.toString(16).padStart(64, '0');
}

function addressWord(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`not an EVM address: ${address}`);
  }
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function bytes32Word(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`not 32 bytes of hex: ${value}`);
  }
  return value.slice(2).toLowerCase();
}

const boolWord = (value: boolean) => uintWord(value ? 1n : 0n);

/** The words of a 0x-hex blob, each 64 hex characters. */
function words(data: string): string[] {
  const hex = data.replace(/^0x/, '');
  if (hex.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('ABI data is not a whole number of words');
  }
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push(hex.slice(i, i + 64));
  return out;
}

function readUint(word: string, bits = 256): bigint {
  const value = BigInt(`0x${word}`);
  if (value > UINT_MAX(bits)) throw new Error(`word exceeds uint${bits}`);
  return value;
}

function readAddress(word: string): string {
  if (!/^0{24}/.test(word)) throw new Error('word is not an address');
  return toChecksumAddress(`0x${word.slice(24)}`);
}

function readBool(word: string): boolean {
  const value = readUint(word, 8);
  if (value > 1n) throw new Error('word is not a bool');
  return value === 1n;
}

const readBytes32 = (word: string) => `0x${word.toLowerCase()}`;

// --- functions -------------------------------------------------------------

const OPEN_PARAMS_TUPLE =
  '(bytes32,address,address,address,uint128,uint128,uint32,uint32,uint32,address,uint16)';

/** Every function signature the service encodes, by name. */
export const P2P_MARKET_FUNCTIONS = {
  deposit: 'deposit(address,uint256)',
  withdraw: 'withdraw(address,uint256)',
  withdrawFor: 'withdrawFor(address,address,uint256)',
  setOperator: 'setOperator(address,uint8)',
  setMatcher: 'setMatcher(address,uint128,bool)',
  open: `open(${OPEN_PARAMS_TUPLE})`,
  openWithDeposit: `openWithDeposit(${OPEN_PARAMS_TUPLE})`,
  accept: 'accept(uint256)',
  markPaid: 'markPaid(uint256)',
  release: 'release(uint256)',
  settle: 'settle(uint256)',
  cancel: 'cancel(uint256)',
  dispute: 'dispute(uint256)',
  resolve: 'resolve(uint256,uint128,uint128)',
  getOrder: 'getOrder(uint256)',
  orderIdOf: 'orderIdOf(address,bytes32)',
  balanceOf: 'balanceOf(address,address)',
  permissionsOf: 'permissionsOf(address,address)',
  matcherTermsOf: 'matcherTermsOf(address,address)',
  protocolFeeBps: 'protocolFeeBps()',
  paused: 'paused()',
  tokenAllowed: 'tokenAllowed(address)',
  owner: 'owner()',
  arbiter: 'arbiter()',
  treasury: 'treasury()',
} as const;
export type P2pMarketFunction = keyof typeof P2P_MARKET_FUNCTIONS;

const SELECTORS = Object.fromEntries(
  Object.entries(P2P_MARKET_FUNCTIONS).map(([name, sig]) => [
    name,
    functionSelector(sig),
  ]),
) as Record<P2pMarketFunction, string>;

/** The selector of one of the contract's functions. */
export const p2pSelector = (name: P2pMarketFunction): string => SELECTORS[name];

/** `OpenParams`, as `open` and `openWithDeposit` take it. */
export interface P2pOpenParams {
  ref: string;
  seller: string;
  buyer: string;
  token: string;
  amount: bigint;
  bond: bigint;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  /** The zero address for none. */
  integrator: string;
  integratorFeeBps: number;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function openParamsWords(p: P2pOpenParams): string {
  return (
    bytes32Word(p.ref) +
    addressWord(p.seller) +
    addressWord(p.buyer) +
    addressWord(p.token) +
    uintWord(p.amount, 128) +
    uintWord(p.bond, 128) +
    uintWord(BigInt(p.acceptWindow), 32) +
    uintWord(BigInt(p.paymentWindow), 32) +
    uintWord(BigInt(p.settleWindow), 32) +
    addressWord(p.integrator) +
    uintWord(BigInt(p.integratorFeeBps), 16)
  );
}

/** Calldata for the order actions that take only an order id. */
export type P2pOrderAction =
  'accept' | 'markPaid' | 'release' | 'settle' | 'cancel' | 'dispute';

export const p2pCalldata = {
  deposit: (token: string, amount: bigint) =>
    SELECTORS.deposit + addressWord(token) + uintWord(amount),
  withdraw: (token: string, amount: bigint) =>
    SELECTORS.withdraw + addressWord(token) + uintWord(amount),
  withdrawFor: (account: string, token: string, amount: bigint) =>
    SELECTORS.withdrawFor +
    addressWord(account) +
    addressWord(token) +
    uintWord(amount),
  setOperator: (operator: string, permissions: number) =>
    SELECTORS.setOperator +
    addressWord(operator) +
    uintWord(BigInt(permissions), 8),
  setMatcher: (matcher: string, maxPerOrder: bigint, autoSettle: boolean) =>
    SELECTORS.setMatcher +
    addressWord(matcher) +
    uintWord(maxPerOrder, 128) +
    boolWord(autoSettle),
  open: (p: P2pOpenParams) => SELECTORS.open + openParamsWords(p),
  openWithDeposit: (p: P2pOpenParams) =>
    SELECTORS.openWithDeposit + openParamsWords(p),
  orderAction: (action: P2pOrderAction, id: bigint) =>
    SELECTORS[action] + uintWord(id),
  resolve: (id: bigint, toBuyer: bigint, bondToSeller: bigint) =>
    SELECTORS.resolve +
    uintWord(id) +
    uintWord(toBuyer, 128) +
    uintWord(bondToSeller, 128),
  getOrder: (id: bigint) => SELECTORS.getOrder + uintWord(id),
  orderIdOf: (opener: string, ref: string) =>
    SELECTORS.orderIdOf + addressWord(opener) + bytes32Word(ref),
  balanceOf: (account: string, token: string) =>
    SELECTORS.balanceOf + addressWord(account) + addressWord(token),
  permissionsOf: (account: string, operator: string) =>
    SELECTORS.permissionsOf + addressWord(account) + addressWord(operator),
  matcherTermsOf: (seller: string, matcher: string) =>
    SELECTORS.matcherTermsOf + addressWord(seller) + addressWord(matcher),
  tokenAllowed: (token: string) => SELECTORS.tokenAllowed + addressWord(token),
  protocolFeeBps: () => SELECTORS.protocolFeeBps,
  paused: () => SELECTORS.paused,
  owner: () => SELECTORS.owner,
  arbiter: () => SELECTORS.arbiter,
  treasury: () => SELECTORS.treasury,
};

/**
 * The init code of a P2PMarket with these constructor arguments. Run as a
 * creation `eth_call`, a node answers the runtime code such a deployment has:
 * the contract has no immutables, so any valid arguments give the runtime the
 * deployed one must equal byte for byte.
 */
export function p2pMarketInitCode(
  bytecode: string,
  args: { owner: string; treasury: string; arbiter: string; feeBps: number },
): string {
  return (
    bytecode +
    addressWord(args.owner) +
    addressWord(args.treasury) +
    addressWord(args.arbiter) +
    uintWord(BigInt(args.feeBps), 16)
  );
}

// --- views -------------------------------------------------------------------

/** The contract's order statuses, in declaration order. */
export const P2P_CHAIN_STATUSES = [
  'None',
  'Offered',
  'Active',
  'Paid',
  'Disputed',
  'Released',
  'Cancelled',
  'Resolved',
] as const;
export type P2pChainStatus = (typeof P2P_CHAIN_STATUSES)[number];

/** `getOrder(id)`, as the contract stores it. */
export interface P2pChainOrder {
  seller: string;
  acceptDeadline: number;
  paymentDeadline: number;
  status: P2pChainStatus;
  fromBalance: boolean;
  buyer: string;
  paidAt: number;
  paymentWindow: number;
  feeBps: number;
  viaMatcher: boolean;
  token: string;
  settleWindow: number;
  integratorFeeBps: number;
  opener: string;
  integrator: string;
  amount: bigint;
  bond: bigint;
  ref: string;
}

function chainStatus(word: string): P2pChainStatus {
  const index = Number(readUint(word, 8));
  const status = P2P_CHAIN_STATUSES[index];
  if (!status) throw new Error(`unknown order status ${index}`);
  return status;
}

/** Decodes `getOrder`'s answer: the 18 static words of `Order`. */
export function decodeChainOrder(data: string): P2pChainOrder {
  const w = words(data);
  if (w.length !== 18) throw new Error('getOrder answers 18 words');
  return {
    seller: readAddress(w[0]),
    acceptDeadline: Number(readUint(w[1], 40)),
    paymentDeadline: Number(readUint(w[2], 40)),
    status: chainStatus(w[3]),
    fromBalance: readBool(w[4]),
    buyer: readAddress(w[5]),
    paidAt: Number(readUint(w[6], 40)),
    paymentWindow: Number(readUint(w[7], 32)),
    feeBps: Number(readUint(w[8], 16)),
    viaMatcher: readBool(w[9]),
    token: readAddress(w[10]),
    settleWindow: Number(readUint(w[11], 32)),
    integratorFeeBps: Number(readUint(w[12], 16)),
    opener: readAddress(w[13]),
    integrator: readAddress(w[14]),
    amount: readUint(w[15], 128),
    bond: readUint(w[16], 128),
    ref: readBytes32(w[17]),
  };
}

/** One uint word (`balanceOf`, `orderIdOf`, `protocolFeeBps`, `permissionsOf`). */
export function decodeUint(data: string, bits = 256): bigint {
  const w = words(data);
  if (w.length !== 1) throw new Error('expected one word');
  return readUint(w[0], bits);
}

export function decodeBool(data: string): boolean {
  const w = words(data);
  if (w.length !== 1) throw new Error('expected one word');
  return readBool(w[0]);
}

export function decodeAddress(data: string): string {
  const w = words(data);
  if (w.length !== 1) throw new Error('expected one word');
  return readAddress(w[0]);
}

/** `matcherTermsOf(seller, matcher)`. */
export interface P2pMatcherTerms {
  maxPerOrder: bigint;
  autoSettle: boolean;
}

export function decodeMatcherTerms(data: string): P2pMatcherTerms {
  const w = words(data);
  if (w.length !== 2) throw new Error('matcherTermsOf answers 2 words');
  return { maxPerOrder: readUint(w[0], 128), autoSettle: readBool(w[1]) };
}

// --- events -------------------------------------------------------------------

/** Every event the indexer reads, by name, with its signature. */
export const P2P_MARKET_EVENTS = {
  OperatorSet: 'OperatorSet(address,address,uint8)',
  MatcherSet: 'MatcherSet(address,address,uint128,bool)',
  OrderOpened:
    'OrderOpened(uint256,address,bytes32,address,address,address,uint128,uint128,bool)',
  OrderAccepted: 'OrderAccepted(uint256,uint40)',
  OrderPaid: 'OrderPaid(uint256,address)',
  OrderReleased: 'OrderReleased(uint256,address,uint256,uint256,uint256)',
  OrderCancelled: 'OrderCancelled(uint256,address)',
  OrderDisputed: 'OrderDisputed(uint256,address)',
  OrderResolved:
    'OrderResolved(uint256,uint256,uint256,uint256,uint256,uint256)',
} as const;
export type P2pMarketEventName = keyof typeof P2P_MARKET_EVENTS;

/** topic0 of each event: keccak-256 of its signature. */
export const P2P_EVENT_TOPICS = Object.fromEntries(
  Object.entries(P2P_MARKET_EVENTS).map(([name, sig]) => [
    name,
    keccakText(sig),
  ]),
) as Record<P2pMarketEventName, string>;

export type P2pMarketEvent =
  | {
      name: 'OperatorSet';
      account: string;
      operator: string;
      permissions: number;
    }
  | {
      name: 'MatcherSet';
      seller: string;
      matcher: string;
      maxPerOrder: bigint;
      autoSettle: boolean;
    }
  | {
      name: 'OrderOpened';
      id: bigint;
      opener: string;
      ref: string;
      seller: string;
      buyer: string;
      token: string;
      amount: bigint;
      bond: bigint;
      viaMatcher: boolean;
    }
  | { name: 'OrderAccepted'; id: bigint; paymentDeadline: number }
  | { name: 'OrderPaid'; id: bigint; by: string }
  | {
      name: 'OrderReleased';
      id: bigint;
      by: string;
      toBuyer: bigint;
      protocolFee: bigint;
      integratorFee: bigint;
    }
  | { name: 'OrderCancelled'; id: bigint; by: string }
  | { name: 'OrderDisputed'; id: bigint; by: string }
  | {
      name: 'OrderResolved';
      id: bigint;
      toBuyer: bigint;
      toSeller: bigint;
      bondToSeller: bigint;
      protocolFee: bigint;
      integratorFee: bigint;
    };

const TOPIC_TO_EVENT = new Map(
  Object.entries(P2P_EVENT_TOPICS).map(([name, topic]) => [
    topic,
    name as P2pMarketEventName,
  ]),
);

/** A log as `eth_getLogs` answers it (only the parts decoding reads). */
export interface P2pRawLog {
  topics: readonly string[];
  data: string;
}

function topicWord(topic: string | undefined): string {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error('missing or malformed topic');
  }
  return topic.slice(2);
}

/**
 * Decodes one of the contract's logs by its topic0, or answers null for a log
 * that is not one of {@link P2P_MARKET_EVENTS}. Throws on a log whose topic0
 * matches but whose topics or data do not have the event's shape: that is not
 * this contract, and the indexer must not guess.
 */
export function decodeP2pMarketLog(log: P2pRawLog): P2pMarketEvent | null {
  const name = TOPIC_TO_EVENT.get((log.topics[0] ?? '').toLowerCase());
  if (!name) return null;
  const t = (i: number) => topicWord(log.topics[i]);
  const d = words(log.data);
  const expect = (topics: number, dataWords: number) => {
    if (log.topics.length !== topics || d.length !== dataWords) {
      throw new Error(`${name} log has the wrong shape`);
    }
  };
  switch (name) {
    case 'OperatorSet':
      expect(3, 1);
      return {
        name,
        account: readAddress(t(1)),
        operator: readAddress(t(2)),
        permissions: Number(readUint(d[0], 8)),
      };
    case 'MatcherSet':
      expect(3, 2);
      return {
        name,
        seller: readAddress(t(1)),
        matcher: readAddress(t(2)),
        maxPerOrder: readUint(d[0], 128),
        autoSettle: readBool(d[1]),
      };
    case 'OrderOpened':
      expect(4, 6);
      return {
        name,
        id: readUint(t(1)),
        opener: readAddress(t(2)),
        ref: readBytes32(t(3)),
        seller: readAddress(d[0]),
        buyer: readAddress(d[1]),
        token: readAddress(d[2]),
        amount: readUint(d[3], 128),
        bond: readUint(d[4], 128),
        viaMatcher: readBool(d[5]),
      };
    case 'OrderAccepted':
      expect(2, 1);
      return {
        name,
        id: readUint(t(1)),
        paymentDeadline: Number(readUint(d[0], 40)),
      };
    case 'OrderPaid':
    case 'OrderCancelled':
    case 'OrderDisputed':
      expect(2, 1);
      return { name, id: readUint(t(1)), by: readAddress(d[0]) };
    case 'OrderReleased':
      expect(2, 4);
      return {
        name,
        id: readUint(t(1)),
        by: readAddress(d[0]),
        toBuyer: readUint(d[1]),
        protocolFee: readUint(d[2]),
        integratorFee: readUint(d[3]),
      };
    case 'OrderResolved':
      expect(2, 5);
      return {
        name,
        id: readUint(t(1)),
        toBuyer: readUint(d[0]),
        toSeller: readUint(d[1]),
        bondToSeller: readUint(d[2]),
        protocolFee: readUint(d[3]),
        integratorFee: readUint(d[4]),
      };
  }
}

// --- errors -------------------------------------------------------------------

/** The contract's custom errors, for reading a revert the node relays. */
const P2P_MARKET_ERRORS = [
  'Reentrant()',
  'NotOwner()',
  'NotPendingOwner()',
  'NotArbiter()',
  'NotAuthorized()',
  'IsPaused()',
  'ZeroAddress()',
  'ZeroAmount()',
  'TokenNotAllowed(address)',
  'FeeTooHigh()',
  'BadWindow()',
  'BadIntegrator()',
  'SameParty()',
  'RefTaken(bytes32)',
  'EmptyRef()',
  'InsufficientBalance(uint256,uint256)',
  'ShortDeposit(uint256,uint256)',
  'TokenCallFailed(address)',
  'UnknownOrder(uint256)',
  'WrongStatus(uint8)',
  'Expired()',
  'NotYet()',
  'BadSplit()',
  'InvalidPermissions()',
];

const ERROR_BY_SELECTOR = new Map(
  P2P_MARKET_ERRORS.map((sig) => [
    functionSelector(sig),
    sig.slice(0, sig.indexOf('(')),
  ]),
);

/**
 * The name of the contract error a revert carries (`InsufficientBalance`), or
 * null when the data is not one of them. Reads only the selector: the
 * arguments stay in the log the operator reads.
 */
export function p2pRevertName(data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  return ERROR_BY_SELECTOR.get(data.slice(0, 10).toLowerCase()) ?? null;
}
