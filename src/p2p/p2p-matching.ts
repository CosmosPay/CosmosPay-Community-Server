import type { P2pTradeSide } from '@/p2p/p2p-pricing';

/**
 * Which merchant takes a trade. Pure: `P2pQuotesService` loads the offers
 * the database can filter (side, tier, network, token, currency), then this
 * decides the rest and the order, and the chain decides last (a merchant's
 * free balance and its matcher terms, read only for the best few).
 *
 * The person never picks a merchant: they type an amount and get the best
 * price a merchant who can fill it right now offers (the p2p.me model).
 */

/** What an offer and its merchant bring to a match. */
export interface P2pOfferCandidate {
  offerId: string;
  accountId: string;
  /** Local money per token, in price units. */
  priceUnits: bigint;
  priceUpdatedAt: Date;
  priceTtlSeconds: number;
  /** Local money bounds, minor units. */
  minFiatUnits: bigint;
  maxFiatUnits: bigint;
  rails: readonly string[];
  merchantStatus: string;
  /** Orders of this merchant account still locking tokens. */
  openOrders: number;
  /** Whether the merchant holds an active payment method for the rail (purchases only). */
  hasPaymentMethod: boolean;
  completed: number;
  cancelled: number;
  disputesLost: number;
  medianReleaseSeconds: number | null;
}

export interface P2pMatchRequest {
  side: P2pTradeSide;
  rail: string;
  now: Date;
  maxOpenOrders: number;
}

/** Why an offer was left out, for the operator's log and the spec. */
export type P2pOfferRefusal =
  'merchant_inactive' | 'price_stale' | 'rail' | 'payment_method' | 'busy';

/** The reason `offer` cannot take this trade, or null when it can (amount aside). */
export function offerRefusal(
  offer: P2pOfferCandidate,
  request: P2pMatchRequest,
): P2pOfferRefusal | null {
  if (offer.merchantStatus !== 'ACTIVE') return 'merchant_inactive';
  const age = request.now.getTime() - offer.priceUpdatedAt.getTime();
  if (age > offer.priceTtlSeconds * 1000) return 'price_stale';
  if (!offer.rails.includes(request.rail)) return 'rail';
  // A purchase shows the person where to pay: the merchant must have an account there.
  if (request.side === 'BUY' && !offer.hasPaymentMethod) {
    return 'payment_method';
  }
  if (offer.openOrders >= request.maxOpenOrders) return 'busy';
  return null;
}

/** Whether local money `fiatUnits` is within the offer's bounds. */
export function withinLimits(
  offer: P2pOfferCandidate,
  fiatUnits: bigint,
): boolean {
  return fiatUnits >= offer.minFiatUnits && fiatUnits <= offer.maxFiatUnits;
}

/**
 * A merchant's completed share of the orders it had to act on; a merchant
 * with no history ranks as if half its orders had completed, below a proven
 * merchant and above a failing one.
 */
export function completionRate(stats: {
  completed: number;
  cancelled: number;
}): number {
  const total = stats.completed + stats.cancelled;
  return total === 0 ? 0.5 : stats.completed / total;
}

/**
 * The order offers are tried in: the best price for the person first (a buyer
 * pays the least, a seller receives the most), then reputation (completion
 * rate, median release time, disputes lost), then the merchant with the fewest
 * open orders, then the offer id, so two equal offers always rank the same way.
 */
export function rankOffers<T extends P2pOfferCandidate>(
  offers: readonly T[],
  side: P2pTradeSide,
): T[] {
  return [...offers].sort((a, b) => {
    if (a.priceUnits !== b.priceUnits) {
      const cheaper = a.priceUnits < b.priceUnits ? -1 : 1;
      return side === 'BUY' ? cheaper : -cheaper;
    }
    const rate = completionRate(b) - completionRate(a);
    if (rate !== 0) return rate;
    const release =
      (a.medianReleaseSeconds ?? Number.MAX_SAFE_INTEGER) -
      (b.medianReleaseSeconds ?? Number.MAX_SAFE_INTEGER);
    if (release !== 0) return release;
    if (a.disputesLost !== b.disputesLost) {
      return a.disputesLost - b.disputesLost;
    }
    if (a.openOrders !== b.openOrders) return a.openOrders - b.openOrders;
    return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
  });
}

/** What the chain says about a merchant for one trade. */
export interface P2pMerchantLiquidity {
  /** Its free balance of the token in the contract. */
  freeBalance: bigint;
  /** `matcherTermsOf(merchant, matcher).maxPerOrder`; only purchases read it. */
  maxPerOrder: bigint;
}

/**
 * Whether the merchant can take the trade on-chain right now. A purchase locks
 * the merchant's own tokens through the matcher: its free balance must cover
 * the amount and its matcher terms must allow an order that big. A sale locks
 * the person's tokens and only the merchant's bond: its free balance must
 * cover the bond, which its `accept` takes.
 */
export function hasLiquidity(
  side: P2pTradeSide,
  liquidity: P2pMerchantLiquidity,
  amount: bigint,
  bond: bigint,
): boolean {
  if (side === 'BUY') {
    return liquidity.freeBalance >= amount && liquidity.maxPerOrder >= amount;
  }
  return liquidity.freeBalance >= bond;
}
