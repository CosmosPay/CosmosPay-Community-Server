import { toChecksumAddress } from '@/chains/chain-address';
import {
  ELDORADO_ADDRESS_PARAM,
  ELDORADO_CHAIN_NAMES,
  NATIVE_TOKEN_ADDRESS,
  P2P_SESSION_REFERENCE_PREFIX,
  P2P_MAIN_TOKENS,
  P2P_TOKEN_PRIORITY,
  P2P_USD_STABLECOINS,
  type EldoradoHost,
  type EldoradoToken,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * The marketplace's market, as this API publishes it, and the pure rules over
 * it: which currencies can be traded, on which chains and tokens, whether an
 * order fits, what it is about worth, and the widget URL that takes it. No Nest
 * and no I/O, so a spec calls them on recorded answers.
 *
 * Two sides share every rule: `buy` (`/v1/onramp/p2p`, local money in, a token
 * out) and `sell` (`/v1/offramp/p2p`, a token in, local money out). An order's
 * `amount` is always what it puts in. The P2P leg is priced in USD stablecoins
 * (`/prices`); any other token is reached through the widget's swap, valued here
 * at the marketplace's USD price for it.
 */

/** Which way an order goes: a purchase of a token, or a sale of one. */
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
 * One side of `/prices` (`BUY` or `SELL`), keyed by currency id. `price` is
 * local money per USD stablecoin; `limits.in.min` is in what an order of that
 * side puts in: local money on `BUY`, USD stablecoin on `SELL`.
 */
export type RawPriceSide = Record<
  string,
  { price?: unknown; limits?: { in?: { min?: unknown } } } | undefined
>;

/** A token as `/chains/{chainId}/tokens` lists it. Every field is checked before use. */
export interface RawToken {
  address?: unknown;
  symbol?: unknown;
  decimals?: unknown;
  chainId?: unknown;
  priceUSD?: unknown;
  logo?: unknown;
}

export interface P2pPaymentMethod {
  id: string;
  name: string;
}

export interface P2pCurrency {
  id: string;
  /** English name, else the id. */
  name: string;
  /** Local money per USD stablecoin on this side (what a buyer pays, what a seller gets), a decimal string. */
  price: string;
  /** Least one order puts in, a decimal string: local money to buy, USD to sell. */
  minAmount: string;
  paymentMethods: P2pPaymentMethod[];
}

/** A token an order can name, as this API publishes it. */
export interface P2pToken {
  chainId: number;
  /** EIP-55; the zero address is the chain's own coin. */
  address: string;
  symbol: string;
  decimals: number;
  /** USD per token, a decimal string, or null when the marketplace has none. */
  priceUsd: string | null;
  /** Its logo as the marketplace lists it (https), or null ({@link tokenLogoUrl}). */
  logoUrl: string | null;
}

/** A chain the market trades on, with how many tokens it lists there. */
export interface P2pNetwork {
  chainId: number;
  name: string;
  tokenCount: number;
}

export interface P2pMarket {
  currencies: P2pCurrency[];
  networks: P2pNetwork[];
  defaultToken: EldoradoToken;
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
 * The currencies one side can actually trade: fiat, with a price, a minimum and
 * at least one payment method. A currency missing any of them is left out
 * rather than offered and refused later (the live market lists BOB with a price
 * and no method). `prices` is that side of `/prices`; a side the marketplace did
 * not send (or sent unreadable) offers nothing.
 */
export function buildCurrencies(
  currencies: RawCurrency[],
  methods: RawPaymentMethod[],
  prices: RawPriceSide | null | undefined,
): P2pCurrency[] {
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
  return out;
}

/** The chain ids `/chains` lists (strings there), as numbers; anything else is dropped. */
export function readChainIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const entry of raw as unknown[]) {
    const text: unknown = typeof entry === 'number' ? String(entry) : entry;
    if (typeof text !== 'string' || !/^[1-9]\d{0,15}$/.test(text)) continue;
    const id = Number(text);
    if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A chain's name: {@link ELDORADO_CHAIN_NAMES}, else `Chain <id>`. */
export function chainName(chainId: number): string {
  return ELDORADO_CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

/**
 * A USD price for a token: the marketplace's `priceUSD`, else 1 for a USD
 * stablecoin ({@link P2P_USD_STABLECOINS}: the sandbox's test USDT has none),
 * else null.
 */
export function tokenUsdPrice(symbol: string, raw: unknown): string | null {
  return (
    positiveDecimal(raw) ?? (P2P_USD_STABLECOINS.includes(symbol) ? '1' : null)
  );
}

/**
 * Hosts whose images are never passed on: CoinGecko's and CoinMarketCap's terms do not let others
 * reuse them (the developer platform's logo rule refuses them too).
 */
const BLOCKED_LOGO_HOSTS = /(^|\.)(coingecko\.com|coinmarketcap\.com)$/i;

/**
 * A token's logo as the marketplace lists it, for a picker to show where it has no artwork of its
 * own (most of a chain's thousands of tokens): an https address of at most 512 characters on a
 * host that allows reuse, else null. The image is the listing's, not checked by this service.
 */
export function tokenLogoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || BLOCKED_LOGO_HOSTS.test(url.hostname))
    return null;
  return url.toString();
}

/** Each network's main assets, lowercased once. */
const MAIN_TOKENS = new Map<number, readonly string[]>(
  Object.entries(P2P_MAIN_TOKENS).map(([chainId, list]) => [
    Number(chainId),
    list.map((address) => address.toLowerCase()),
  ]),
);

/**
 * Where a token sorts: its place among its network's main assets
 * ({@link P2P_MAIN_TOKENS}, by address), or for a network without that list its
 * place in {@link P2P_TOKEN_PRIORITY} (by symbol); past the end when absent.
 */
function priorityOf(token: P2pToken): number {
  const mains = MAIN_TOKENS.get(token.chainId);
  if (mains) {
    const at = mains.indexOf(token.address.toLowerCase());
    return at < 0 ? mains.length : at;
  }
  const key = token.address === NATIVE_TOKEN_ADDRESS ? 'native' : token.symbol;
  const at = P2P_TOKEN_PRIORITY.indexOf(key);
  return at < 0 ? P2P_TOKEN_PRIORITY.length : at;
}

/**
 * One chain's token list, read and ordered: entries with an EVM address, a
 * symbol and integer decimals (0 to 36), EIP-55, each address once, the
 * network's main assets first ({@link priorityOf}) and the rest in the
 * marketplace's order.
 */
export function readTokens(raw: unknown, chainId: number): P2pToken[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tokens: P2pToken[] = [];
  for (const entry of raw as RawToken[]) {
    if (!entry || typeof entry !== 'object') continue;
    const { address, symbol, decimals } = entry;
    if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address))
      continue;
    if (typeof symbol !== 'string' || !symbol.trim() || symbol.length > 64)
      continue;
    if (
      typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 36
    )
      continue;
    const lower = address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const name = symbol.trim();
    tokens.push({
      chainId,
      address: toChecksumAddress(lower),
      symbol: name,
      decimals,
      priceUsd: tokenUsdPrice(name, entry.priceUSD),
      logoUrl: tokenLogoUrl(entry.logo),
    });
  }
  // A stable sort: ties keep the marketplace's order.
  return tokens
    .map((token, at) => ({ token, at, rank: priorityOf(token) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((x) => x.token);
}

/**
 * The networks a market offers: the chains whose token list loaded with at
 * least one token, the default chain first, then the longest lists.
 */
export function buildNetworks(
  lists: ReadonlyMap<number, readonly P2pToken[]>,
  defaultChainId: number,
): P2pNetwork[] {
  return [...lists.entries()]
    .filter(([, tokens]) => tokens.length > 0)
    .map(([chainId, tokens]) => ({
      chainId,
      name: chainName(chainId),
      tokenCount: tokens.length,
    }))
    .sort(
      (a, b) =>
        Number(b.chainId === defaultChainId) -
          Number(a.chainId === defaultChainId) || b.tokenCount - a.tokenCount,
    );
}

/**
 * The tokens `q` names: an exact address (any case), else every token whose
 * symbol contains it (any case). An empty query is the whole list.
 */
export function searchTokens(
  tokens: readonly P2pToken[],
  q: string | undefined,
): readonly P2pToken[] {
  const query = (q ?? '').trim().toLowerCase();
  if (!query) return tokens;
  if (/^0x[a-f0-9]{40}$/.test(query)) {
    return tokens.filter((t) => t.address.toLowerCase() === query);
  }
  return tokens.filter((t) => t.symbol.toLowerCase().includes(query));
}

/** The token `address` names in a chain's list (any case), or null. */
export function findToken(
  tokens: readonly P2pToken[],
  address: string,
): P2pToken | null {
  const lower = address.toLowerCase();
  return tokens.find((t) => t.address.toLowerCase() === lower) ?? null;
}

/** What an order asks for, once its fields have passed the DTO. */
export interface P2pOrder {
  /** Local currency paid (buy) or received (sell). */
  currency: string;
  /** How that local money is paid (buy) or received (sell). */
  paymentMethod: string;
  /** EIP-155 id of the chain the token is on. */
  chainId: number;
  /** The token's contract on `chainId`; the zero address for the chain's own coin. */
  token: string;
  /** What the order puts in, a decimal string: local money to buy, the token to sell. */
  amount: string;
  /** The 0x account a purchase delivers to, or the one a sale sends from. */
  address: string;
}

/** How many decimals a decimal string carries. */
function decimalsOf(amount: string): number {
  const dot = amount.indexOf('.');
  return dot < 0 ? 0 : amount.length - dot - 1;
}

/**
 * Rounds `value` DOWN for an estimate (it never promises more than the price
 * gives): to the cent for local money and for a token amount of 1 or more, to
 * six decimals below 1. The nudge keeps a product the float lands a hair under
 * (0.57 * 100) on its cent.
 */
function floorEstimate(value: number, localMoney: boolean): string {
  const places = localMoney || value >= 1 ? 2 : 6;
  const scale = 10 ** places;
  return (Math.floor(value * scale + 1e-9) / scale).toFixed(places);
}

/** Rounds a token amount UP the same way, for the "about N" of a minimum. */
function ceilTokenAmount(value: number): string {
  const places = value >= 1 ? 2 : 6;
  const scale = 10 ** places;
  return (Math.ceil(value * scale - 1e-9) / scale).toFixed(places);
}

/**
 * Why `order` cannot be traded on `market` on `side`, or null when it can.
 * `tokens` is the token list of `order.chainId`, or null when the market does
 * not offer that chain.
 */
export function orderProblem(
  market: P2pMarket,
  tokens: readonly P2pToken[] | null,
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
      : `tokens cannot be sold for ${order.currency} (offered: ${offered})`;
  }
  if (!currency.paymentMethods.some((m) => m.id === order.paymentMethod)) {
    const offered = currency.paymentMethods.map((m) => m.id).join(', ');
    return `paymentMethod ${order.paymentMethod} does not ${buying ? 'pay in' : 'pay out'} ${currency.id} (offered: ${offered})`;
  }
  const unoffered = chainProblem(market, order.chainId);
  if (unoffered) return unoffered;
  const token = tokens ? findToken(tokens, order.token) : null;
  if (!token) {
    return `token ${order.token} is not offered on chain ${order.chainId}; list them with GET /v1/${buying ? 'onramp' : 'offramp'}/p2p/tokens?chainId=${order.chainId}`;
  }
  if (buying && decimalsOf(order.amount) > 2) {
    return 'amount is local money: at most two decimals';
  }
  if (!buying && decimalsOf(order.amount) > token.decimals) {
    return `amount has more decimals than ${token.symbol} (${token.decimals})`;
  }
  if (buying && Number(order.amount) < Number(currency.minAmount)) {
    return `amount is below the minimum of ${currency.minAmount} ${currency.id}`;
  }
  // A sale's minimum is in USD: checked only where the token has a USD price
  // (the widget checks the rest before anything moves).
  if (
    !buying &&
    token.priceUsd !== null &&
    Number(order.amount) * Number(token.priceUsd) < Number(currency.minAmount)
  ) {
    const about = ceilTokenAmount(
      Number(currency.minAmount) / Number(token.priceUsd),
    );
    return `amount is below the minimum of ${currency.minAmount} USD (about ${about} ${token.symbol})`;
  }
  return null;
}

/** Why `chainId` is not one of the market's networks, or null when it is. */
export function chainProblem(
  market: P2pMarket,
  chainId: number,
): string | null {
  if (market.networks.some((n) => n.chainId === chainId)) return null;
  const offered =
    market.networks.map((n) => n.chainId).join(', ') || 'none right now';
  return `chainId ${chainId} is not offered (offered: ${offered})`;
}

/**
 * About what `amount` gives at the market price, rounded DOWN: the tokens a
 * purchase delivers (`amount / price / priceUsd`) or the local money a sale
 * pays (`amount * priceUsd * price`). Null when the token has no USD price. The
 * widget shows the firm figure, fees and the swap included, before anything moves.
 */
export function estimateAmountOut(
  amount: string,
  price: string,
  priceUsd: string | null,
  side: P2pSide,
): string | null {
  if (priceUsd === null) return null;
  const usd = Number(priceUsd);
  return side === 'buy'
    ? floorEstimate(Number(amount) / Number(price) / usd, false)
    : floorEstimate(Number(amount) * usd * Number(price), true);
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
 * The widget URL that opens `order` on `side` for `token` (on its chain), with
 * the session's reference. A purchase fixes `order.address` as the recipient
 * ({@link ELDORADO_ADDRESS_PARAM}). A sale does not: with that parameter the
 * widget counts the wallet as connected and has nothing to sign the transfer
 * with, so the seller connects the wallet that holds the token there. The
 * integrator ids ride along when configured, which is what attributes the order.
 */
export function widgetUrl(
  host: EldoradoHost,
  order: P2pOrder,
  token: P2pToken,
  reference: string,
  ids: IntegratorIds | null,
  side: P2pSide,
): string {
  const url = new URL('/exchange', host.widget);
  const q = url.searchParams;
  q.set('operation', P2P_PRICE_SIDE[side]);
  q.set('token', token.address);
  q.set('chain', String(token.chainId));
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
