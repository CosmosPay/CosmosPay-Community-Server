import {
  ELDORADO_ADDRESS_PARAM,
  P2P_SESSION_REFERENCE_PREFIX,
  type EldoradoHost,
  type EldoradoToken,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * The marketplace's market, as this API publishes it, and the pure rules over
 * it: which currencies can be traded, whether an order fits, what it is about
 * worth, and the widget URL that takes it. No Nest and no I/O, so a spec calls
 * them on recorded answers.
 *
 * Two sides share every rule: `buy` (`/v1/onramp/p2p`, local money in, the
 * stablecoin out) and `sell` (`/v1/offramp/p2p`, the stablecoin in, local money
 * out). An order's `amount` is always what it puts in.
 */

/** Which way an order goes: a purchase of the stablecoin, or a sale of it. */
export type P2pSide = 'buy' | 'sell';

/** The `/prices` side each order side reads. */
export const P2P_PRICE_SIDE: Record<P2pSide, 'BUY' | 'SELL'> = {
  buy: 'BUY',
  sell: 'SELL',
};

/** A payment method as `/payment-methods` lists it (only the fields used here). */
export interface RawPaymentMethod {
  id: string;
  name: string;
  currency: string;
}

/** A currency as `/currencies` lists it (only the fields used here). */
export interface RawCurrency {
  id: string;
  type: string;
  description?: Record<string, string | undefined> | null;
}

/**
 * One side of `/prices` (`BUY` or `SELL`), keyed by currency id. `limits.in.min`
 * is in what an order of that side puts in: local money on `BUY`, the stablecoin
 * on `SELL`.
 */
export type RawPriceSide = Record<
  string,
  { price?: unknown; limits?: { in?: { min?: unknown } } } | undefined
>;

export interface P2pPaymentMethod {
  id: string;
  name: string;
}

export interface P2pCurrency {
  id: string;
  /** English name, else the id. */
  name: string;
  /** Local money per stablecoin on this side (what a buyer pays, what a seller gets), a decimal string. */
  price: string;
  /** Least one order puts in, a decimal string: local money to buy, the stablecoin to sell. */
  minAmount: string;
  paymentMethods: P2pPaymentMethod[];
}

export interface P2pMarket {
  chainId: number;
  chain: string;
  tokens: readonly EldoradoToken[];
  currencies: P2pCurrency[];
}

/** Both sides of one network's market, read together. */
export type P2pMarkets = Record<P2pSide, P2pMarket>;

/** A positive decimal (the marketplace sends strings), or null. */
export function positiveDecimal(raw: unknown): string | null {
  const text =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text) > 0 ? text : null;
}

/**
 * The currencies one side can actually trade: fiat, with a price, a minimum and
 * at least one payment method. A currency missing any of them is left out
 * rather than offered and refused later (the live market lists BOB with a price
 * and no method). `prices` is that side of `/prices`; a side the marketplace did
 * not send (or sent unreadable) offers nothing.
 */
export function buildMarket(
  host: EldoradoHost,
  currencies: RawCurrency[],
  methods: RawPaymentMethod[],
  prices: RawPriceSide | null | undefined,
): P2pMarket {
  const out: P2pCurrency[] = [];
  const side = prices && typeof prices === 'object' ? prices : {};
  for (const currency of currencies) {
    if (currency.type !== 'FIAT') continue;
    const entry = side[currency.id];
    const price = positiveDecimal(entry?.price);
    const minAmount = positiveDecimal(entry?.limits?.in?.min);
    const paymentMethods = methods
      .filter((m) => m.currency === currency.id)
      .map((m) => ({ id: m.id, name: m.name }));
    if (!price || !minAmount || paymentMethods.length === 0) continue;
    const english = currency.description?.en;
    out.push({
      id: currency.id,
      name:
        typeof english === 'string' && english.trim()
          ? english.trim()
          : currency.id,
      price,
      minAmount,
      paymentMethods,
    });
  }
  return {
    chainId: host.chainId,
    chain: host.chain,
    tokens: host.tokens,
    currencies: out,
  };
}

/** What an order asks for, once its fields have passed the DTO. */
export interface P2pOrder {
  /** Local currency paid (buy) or received (sell). */
  currency: string;
  /** How that local money is paid (buy) or received (sell). */
  paymentMethod: string;
  token: string;
  /** What the order puts in, a decimal string: local money to buy, the stablecoin to sell. */
  amount: string;
  /** The 0x account a purchase delivers to, or the one a sale sends from. */
  address: string;
}

/** Why `order` cannot be traded on `market` on `side`, or null when it can. */
export function orderProblem(
  market: P2pMarket,
  order: P2pOrder,
  side: P2pSide,
): string | null {
  const buying = side === 'buy';
  const currency = market.currencies.find((c) => c.id === order.currency);
  if (!currency) {
    const offered =
      market.currencies.map((c) => c.id).join(', ') || 'none right now';
    return buying
      ? `currency ${order.currency} cannot be bought (offered: ${offered})`
      : `stablecoins cannot be sold for ${order.currency} (offered: ${offered})`;
  }
  if (!currency.paymentMethods.some((m) => m.id === order.paymentMethod)) {
    const offered = currency.paymentMethods.map((m) => m.id).join(', ');
    return `paymentMethod ${order.paymentMethod} does not ${buying ? 'pay in' : 'pay out'} ${currency.id} (offered: ${offered})`;
  }
  if (!market.tokens.some((t) => t.symbol === order.token)) {
    const offered = market.tokens.map((t) => t.symbol).join(', ');
    return buying
      ? `token ${order.token} is not delivered on this network (offered: ${offered})`
      : `token ${order.token} cannot be sold on this network (offered: ${offered})`;
  }
  if (Number(order.amount) < Number(currency.minAmount)) {
    return `amount is below the minimum of ${currency.minAmount} ${buying ? currency.id : order.token}`;
  }
  return null;
}

/**
 * About what `amount` gives at the market price, rounded DOWN to the cent: the
 * stablecoin a purchase delivers (`amount / price`) or the local money a sale
 * pays (`amount * price`). An estimate never promises more than the price
 * gives; the widget shows the firm figure, fees included, before anything moves.
 */
export function estimateAmountOut(
  amount: string,
  price: string,
  side: P2pSide,
): string {
  const exact =
    side === 'buy'
      ? Number(amount) / Number(price)
      : Number(amount) * Number(price);
  // The nudge keeps a product the float lands a hair under (0.57 * 100) on its cent.
  const out = Math.floor(exact * 100 + 1e-9) / 100;
  return out.toFixed(2);
}

/** The `externalReferenceId` a session's widget carries: letters, digits and hyphens. */
export function sessionReference(random: string): string {
  return `${P2P_SESSION_REFERENCE_PREFIX}-${random.replace(/[^A-Za-z0-9-]/g, '')}`;
}

/** The integrator ids, when this deployment has them. */
export interface IntegratorIds {
  clientId: string;
  referralId: string;
}

/**
 * The widget URL that opens `order` on `side`, with the session's reference.
 * A purchase fixes `order.address` as the recipient
 * ({@link ELDORADO_ADDRESS_PARAM}). A sale does not: with that parameter the
 * widget counts the wallet as connected and has nothing to sign the transfer
 * with, so the seller connects the wallet that holds the stablecoin there. The
 * integrator ids ride along when configured, which is what attributes the order.
 */
export function widgetUrl(
  host: EldoradoHost,
  order: P2pOrder,
  reference: string,
  ids: IntegratorIds | null,
  side: P2pSide,
): string {
  const token = host.tokens.find((t) => t.symbol === order.token);
  if (!token)
    throw new Error(`token ${order.token} is not traded on ${host.chain}`);
  const url = new URL('/exchange', host.widget);
  const q = url.searchParams;
  q.set('operation', P2P_PRICE_SIDE[side]);
  q.set('token', token.address);
  q.set('chain', String(host.chainId));
  q.set('currency', order.currency);
  q.set('paymentMethod', order.paymentMethod);
  q.set('amount', order.amount);
  if (side === 'buy') q.set(ELDORADO_ADDRESS_PARAM, order.address);
  q.set('externalReferenceId', reference);
  if (ids) {
    q.set('clientId', ids.clientId);
    q.set('referralId', ids.referralId);
  }
  return url.toString();
}
