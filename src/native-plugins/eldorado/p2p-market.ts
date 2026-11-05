import {
  ELDORADO_ADDRESS_PARAM,
  P2P_SESSION_REFERENCE_PREFIX,
  type EldoradoHost,
  type EldoradoToken,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * The marketplace's market, as this API publishes it, and the pure rules over
 * it: which currencies can be bought, whether an order fits, what it is about
 * worth, and the widget URL that takes it. No Nest and no I/O, so a spec calls
 * them on recorded answers.
 */

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

/** One side of `/prices` (`BUY` here), keyed by currency id. */
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
  /** Local money per stablecoin on the buy side, as a decimal string. */
  price: string;
  /** Least local money one order takes, as a decimal string. */
  minAmount: string;
  paymentMethods: P2pPaymentMethod[];
}

export interface P2pMarket {
  chainId: number;
  chain: string;
  tokens: readonly EldoradoToken[];
  currencies: P2pCurrency[];
}

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
 * The currencies a buyer can actually pay with: fiat, with a buy price, a
 * minimum and at least one payment method. A currency missing any of them is
 * left out rather than offered and refused later (the live market lists BOB with
 * a price and no method).
 */
export function buildMarket(
  host: EldoradoHost,
  currencies: RawCurrency[],
  methods: RawPaymentMethod[],
  buy: RawPriceSide,
): P2pMarket {
  const out: P2pCurrency[] = [];
  for (const currency of currencies) {
    if (currency.type !== 'FIAT') continue;
    const side = buy[currency.id];
    const price = positiveDecimal(side?.price);
    const minAmount = positiveDecimal(side?.limits?.in?.min);
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
  currency: string;
  paymentMethod: string;
  token: string;
  /** Local money to pay, a decimal string. */
  amount: string;
  /** The 0x account the stablecoin is delivered to. */
  address: string;
}

/** Why `order` cannot be bought on `market`, or null when it can. */
export function orderProblem(
  market: P2pMarket,
  order: P2pOrder,
): string | null {
  const currency = market.currencies.find((c) => c.id === order.currency);
  if (!currency) {
    const offered =
      market.currencies.map((c) => c.id).join(', ') || 'none right now';
    return `currency ${order.currency} cannot be bought (offered: ${offered})`;
  }
  if (!currency.paymentMethods.some((m) => m.id === order.paymentMethod)) {
    const offered = currency.paymentMethods.map((m) => m.id).join(', ');
    return `paymentMethod ${order.paymentMethod} does not pay in ${currency.id} (offered: ${offered})`;
  }
  if (!market.tokens.some((t) => t.symbol === order.token)) {
    return `token ${order.token} is not delivered on this network (offered: ${market.tokens.map((t) => t.symbol).join(', ')})`;
  }
  if (Number(order.amount) < Number(currency.minAmount)) {
    return `amount is below the minimum of ${currency.minAmount} ${currency.id}`;
  }
  return null;
}

/**
 * About how much stablecoin `amount` buys at the market price, rounded DOWN to
 * the cent: an estimate never promises more than the price gives. The widget
 * shows the firm figure, fees included, before anything is paid.
 */
export function estimateAmountOut(amount: string, price: string): string {
  const out = Math.floor((Number(amount) / Number(price)) * 100) / 100;
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
 * The widget URL that opens `order` as a BUY, with `order.address` fixed as the
 * recipient ({@link ELDORADO_ADDRESS_PARAM}) and the session's reference. The
 * integrator ids ride along when configured, which is what attributes the order.
 */
export function widgetUrl(
  host: EldoradoHost,
  order: P2pOrder,
  reference: string,
  ids: IntegratorIds | null,
): string {
  const token = host.tokens.find((t) => t.symbol === order.token);
  if (!token)
    throw new Error(`token ${order.token} is not delivered on ${host.chain}`);
  const url = new URL('/exchange', host.widget);
  const q = url.searchParams;
  q.set('operation', 'BUY');
  q.set('token', token.address);
  q.set('chain', String(host.chainId));
  q.set('currency', order.currency);
  q.set('paymentMethod', order.paymentMethod);
  q.set('amount', order.amount);
  q.set(ELDORADO_ADDRESS_PARAM, order.address);
  q.set('externalReferenceId', reference);
  if (ids) {
    q.set('clientId', ids.clientId);
    q.set('referralId', ids.referralId);
  }
  return url.toString();
}
