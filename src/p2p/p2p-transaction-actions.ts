import { approveCalldata } from '@/evm/erc20';
import { p2pCalldata, type P2pOrderAction } from '@/p2p/p2p-market-abi';
import { formatUnits } from '@/p2p/p2p-pricing';
import {
  P2P_PERMISSIONS,
  P2P_PERMISSIONS_ALL,
  type P2pPermission,
} from '@/p2p/p2p.constants';
import type { P2pToken } from '@/p2p/p2p-networks';

/**
 * The transactions `POST /v1/p2p/transactions` builds, ONE table: each action
 * says whether it acts on a balance (an account) or on an order, how it reads
 * its arguments, what it refuses, and the call it builds. A new action is one
 * entry. Pure; `P2pTransactionsService` loads the account, the order and the
 * facts each check reads.
 *
 * Every check here only spares a wallet a transaction the contract would
 * revert: the contract is the boundary, and a refused build moves nothing.
 */

export const P2P_TRANSACTION_ACTIONS = [
  'approve',
  'deposit',
  'withdraw',
  'setOperator',
  'setMatcher',
  'accept',
  'markPaid',
  'release',
  'cancel',
  'dispute',
] as const;
export type P2pTransactionAction = (typeof P2P_TRANSACTION_ACTIONS)[number];

/** What an action on a balance knows. */
export interface P2pBalanceContext {
  contract: string;
  /** The signing wallet. */
  from: string;
  matcher: string | null;
  /** Resolves a token the deployment lists (address or symbol), or null. */
  token(value: string): P2pToken | null;
  /** The account publishes an active offer selling tokens (it is a liquidity merchant). */
  sellsLiquidity: boolean;
}

/** What an action on an order knows. */
export interface P2pOrderContext {
  contract: string;
  from: string;
  order: {
    id: string;
    onchainId: string | null;
    status: string;
    sellerAddress: string;
    buyerAddress: string;
    tokenAmount: string;
    netAmount: string;
    tokenSymbol: string;
    tokenDecimals: number;
    acceptDeadline: Date | null;
    paymentDeadline: Date | null;
  };
  now: Date;
}

export interface P2pBuiltCall {
  to: string;
  data: string;
  description: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface BalanceAction<T> {
  scope: 'balance';
  parse(args: Record<string, unknown>, ctx: P2pBalanceContext): Parsed<T>;
  build(value: T, ctx: P2pBalanceContext): P2pBuiltCall;
}

interface OrderAction {
  scope: 'order';
  call: P2pOrderAction;
  /** Why `from` may not do this now, or null. */
  refusal(ctx: P2pOrderContext): string | null;
  describe(ctx: P2pOrderContext): string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^[1-9]\d{0,37}$/;
const MAX_UINT128 = (1n << 128n) - 1n;

function amountArg(
  args: Record<string, unknown>,
  name: string,
  allowZero = false,
): Parsed<bigint> {
  const raw = args[name];
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (
    typeof text !== 'string' ||
    !(UINT_RE.test(text) || (allowZero && text === '0'))
  ) {
    return {
      ok: false,
      error: `args.${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer in base units`,
    };
  }
  return { ok: true, value: BigInt(text) };
}

function tokenArg(
  args: Record<string, unknown>,
  ctx: P2pBalanceContext,
): Parsed<P2pToken> {
  const raw = args.token;
  const token = typeof raw === 'string' ? ctx.token(raw) : null;
  return token
    ? { ok: true, value: token }
    : {
        ok: false,
        error: 'args.token must be a token the market lists on this network',
      };
}

function tokenAndAmount(
  args: Record<string, unknown>,
  ctx: P2pBalanceContext,
): Parsed<{ token: P2pToken; amount: bigint }> {
  const token = tokenArg(args, ctx);
  if (!token.ok) return token;
  const amount = amountArg(args, 'amount');
  if (!amount.ok) return amount;
  return { ok: true, value: { token: token.value, amount: amount.value } };
}

const human = (amount: bigint, token: P2pToken) =>
  `${formatUnits(amount, token.decimals).replace(/\.?0+$/, '')} ${token.symbol}`;

/** Permission bits from a number or a list of names. */
export function permissionBits(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 && value <= P2P_PERMISSIONS_ALL ? value : null;
  }
  if (Array.isArray(value)) {
    let bits = 0;
    for (const name of value) {
      if (typeof name !== 'string' || !(name in P2P_PERMISSIONS)) return null;
      bits |= P2P_PERMISSIONS[name as P2pPermission];
    }
    return bits;
  }
  return null;
}

function deadlinePassed(deadline: Date | null, now: Date): boolean {
  return deadline !== null && now.getTime() > deadline.getTime();
}

const ORDER_ACTIONS: Record<
  'accept' | 'markPaid' | 'release' | 'cancel' | 'dispute',
  OrderAction
> = {
  accept: {
    scope: 'order',
    call: 'accept',
    refusal: ({ order, from }) =>
      order.status !== 'awaiting_acceptance'
        ? `only an order awaiting acceptance can be accepted (this one is ${order.status})`
        : !same(from, order.buyerAddress)
          ? 'only the order’s buyer accepts it'
          : null,
    describe: ({ order }) =>
      `Accept order ${order.onchainId}: locks the bond from your balance`,
  },
  markPaid: {
    scope: 'order',
    call: 'markPaid',
    refusal: ({ order, from }) =>
      order.status !== 'awaiting_payment'
        ? `only an order awaiting payment can be marked paid (this one is ${order.status})`
        : !same(from, order.buyerAddress)
          ? 'only the order’s buyer marks it paid'
          : null,
    describe: ({ order }) =>
      `Mark order ${order.onchainId} paid: you sent the local money`,
  },
  release: {
    scope: 'order',
    call: 'release',
    refusal: ({ order, from }) =>
      order.status !== 'awaiting_payment' && order.status !== 'paid'
        ? `only an order awaiting payment or paid can be released (this one is ${order.status})`
        : !same(from, order.sellerAddress)
          ? 'only the order’s seller releases it'
          : null,
    describe: ({ order }) =>
      `Release order ${order.onchainId}: pays its buyer ${formatUnits(BigInt(order.netAmount), order.tokenDecimals).replace(/\.?0+$/, '')} ${order.tokenSymbol}`,
  },
  cancel: {
    scope: 'order',
    call: 'cancel',
    refusal: ({ order, from, now }) => {
      const buyer = same(from, order.buyerAddress);
      const seller = same(from, order.sellerAddress);
      if (!buyer && !seller)
        return 'only the order’s buyer or seller cancels it';
      switch (order.status) {
        case 'awaiting_acceptance':
          return null;
        case 'awaiting_payment':
          return buyer || deadlinePassed(order.paymentDeadline, now)
            ? null
            : 'the seller may cancel only after the payment deadline';
        case 'paid':
          return buyer
            ? null
            : 'a paid order can be cancelled by its buyer only; dispute it instead';
        default:
          return `a ${order.status} order cannot be cancelled`;
      }
    },
    describe: ({ order }) =>
      `Cancel order ${order.onchainId}: its tokens go back to the seller`,
  },
  dispute: {
    scope: 'order',
    call: 'dispute',
    refusal: ({ order, from }) =>
      order.status !== 'paid'
        ? `only a paid order can be disputed (this one is ${order.status})`
        : !same(from, order.buyerAddress) && !same(from, order.sellerAddress)
          ? 'only the order’s buyer or seller disputes it'
          : null,
    describe: ({ order }) =>
      `Dispute order ${order.onchainId}: the arbiter decides how it is split`,
  },
};

const BALANCE_ACTIONS = {
  approve: {
    scope: 'balance',
    parse: tokenAndAmount,
    build: ({ token, amount }, ctx) => ({
      to: token.address,
      data: approveCalldata(ctx.contract, amount),
      description: `Allow the P2P market to take exactly ${human(amount, token)}`,
    }),
  } satisfies BalanceAction<{ token: P2pToken; amount: bigint }>,
  deposit: {
    scope: 'balance',
    parse: tokenAndAmount,
    build: ({ token, amount }, ctx) => ({
      to: ctx.contract,
      data: p2pCalldata.deposit(token.address, amount),
      description: `Deposit ${human(amount, token)} into your P2P balance (approve it first)`,
    }),
  } satisfies BalanceAction<{ token: P2pToken; amount: bigint }>,
  withdraw: {
    scope: 'balance',
    parse: tokenAndAmount,
    build: ({ token, amount }, ctx) => ({
      to: ctx.contract,
      data: p2pCalldata.withdraw(token.address, amount),
      description: `Withdraw ${human(amount, token)} from your P2P balance to your wallet`,
    }),
  } satisfies BalanceAction<{ token: P2pToken; amount: bigint }>,
  setOperator: {
    scope: 'balance',
    parse: (args, ctx) => {
      const operator = args.operator;
      if (typeof operator !== 'string' || !EVM_RE.test(operator)) {
        return { ok: false, error: 'args.operator must be an EVM address' };
      }
      if (same(operator, ctx.from)) {
        return {
          ok: false,
          error: 'args.operator must be another wallet than the account',
        };
      }
      const bits = permissionBits(args.permissions);
      if (bits === null) {
        return {
          ok: false,
          error: `args.permissions must be bits 0 to ${P2P_PERMISSIONS_ALL} or a list of ${Object.keys(P2P_PERMISSIONS).join(', ')}`,
        };
      }
      return { ok: true, value: { operator, bits } };
    },
    build: ({ operator, bits }, ctx) => ({
      to: ctx.contract,
      data: p2pCalldata.setOperator(operator, bits),
      description:
        bits === 0
          ? `Revoke every permission of ${operator}`
          : `Let ${operator} ${Object.entries(P2P_PERMISSIONS)
              .filter(([, bit]) => bits & bit)
              .map(([name]) => name)
              .join(', ')} for this account`,
    }),
  } satisfies BalanceAction<{ operator: string; bits: number }>,
  setMatcher: {
    scope: 'balance',
    parse: (args, ctx) => {
      if (!ctx.matcher) {
        return {
          ok: false,
          error: 'the matcher is not available on this deployment',
        };
      }
      const max = amountArg(args, 'maxPerOrder', true);
      if (!max.ok) return max;
      if (max.value > MAX_UINT128) {
        return { ok: false, error: 'args.maxPerOrder does not fit uint128' };
      }
      const autoSettle = args.autoSettle ?? false;
      if (typeof autoSettle !== 'boolean') {
        return { ok: false, error: 'args.autoSettle must be a boolean' };
      }
      // A liquidity merchant's orders release only when the merchant says so:
      // with autoSettle, a leaked matcher key could open orders whose silence
      // pays them out (README: the matcher and arbiter trust edge).
      if (autoSettle && ctx.sellsLiquidity) {
        return {
          ok: false,
          error:
            'autoSettle is refused for an account that sells tokens through offers: release its orders yourself',
        };
      }
      return { ok: true, value: { maxPerOrder: max.value, autoSettle } };
    },
    build: ({ maxPerOrder, autoSettle }, ctx) => ({
      to: ctx.contract,
      data: p2pCalldata.setMatcher(
        ctx.matcher as string,
        maxPerOrder,
        autoSettle,
      ),
      description:
        maxPerOrder === 0n
          ? 'Revoke the matcher: no new order opens on your balance'
          : `Let the matcher open orders on your balance up to ${maxPerOrder} base units each${autoSettle ? ', with a settle window' : ''}`,
    }),
  } satisfies BalanceAction<{ maxPerOrder: bigint; autoSettle: boolean }>,
};

export type P2pBalanceAction = keyof typeof BALANCE_ACTIONS;

export function isBalanceAction(
  action: P2pTransactionAction,
): action is P2pBalanceAction {
  return action in BALANCE_ACTIONS;
}

/** Builds a balance action, or answers why not. */
export function buildBalanceAction(
  action: P2pBalanceAction,
  args: Record<string, unknown>,
  ctx: P2pBalanceContext,
): Parsed<P2pBuiltCall> {
  const entry = BALANCE_ACTIONS[action] as BalanceAction<unknown>;
  const parsed = entry.parse(args, ctx);
  if (!parsed.ok) return parsed;
  return { ok: true, value: entry.build(parsed.value, ctx) };
}

/** Builds an order action, or answers why `from` may not. */
export function buildOrderAction(
  action: Exclude<P2pTransactionAction, P2pBalanceAction>,
  ctx: P2pOrderContext,
): Parsed<P2pBuiltCall> {
  const entry = ORDER_ACTIONS[action];
  if (!ctx.order.onchainId) {
    return { ok: false, error: 'the order is not open on-chain yet' };
  }
  const refusal = entry.refusal(ctx);
  if (refusal) return { ok: false, error: refusal };
  return {
    ok: true,
    value: {
      to: ctx.contract,
      data: p2pCalldata.orderAction(entry.call, BigInt(ctx.order.onchainId)),
      description: entry.describe(ctx),
    },
  };
}
