import { P2P_BPS, P2P_PRICE_DECIMALS } from '@/p2p/p2p.constants';

/**
 * Money arithmetic for P2P quotes, in integers only: a price is local money
 * per one token with {@link P2P_PRICE_DECIMALS} decimals, local money is in
 * its currency's minor units, a token amount in the token's base units.
 *
 * Who pays the fees. The contract takes the protocol fee and the integrator
 * fee from what the BUYER of the tokens receives. The person who asked for
 * the quote always bears them, whichever side the contract puts them on:
 *
 *   - a purchase (`BUY`): the person pays local money for the GROSS amount the
 *     order locks, and receives it net of fees;
 *   - a sale (`SELL`): the person locks the gross amount, the merchant receives
 *     it net of fees, and pays local money for that NET amount only.
 */

export type P2pTradeSide = 'BUY' | 'SELL';

const pow10 = (n: number) => 10n ** BigInt(n);

/** A positive decimal with at most `decimals` places, as integer units; null when it is not one. */
export function parseDecimalUnits(
  value: string,
  decimals: number,
): bigint | null {
  const re =
    decimals === 0
      ? /^(\d{1,18})$/
      : new RegExp(`^(\\d{1,18})(?:\\.(\\d{1,${decimals}}))?$`);
  const match = re.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(decimals, '0');
  return whole * pow10(decimals) + (fraction ? BigInt(fraction) : 0n);
}

/** Integer units back to a decimal string with exactly `decimals` places. */
export function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / pow10(decimals);
  const fraction = (abs % pow10(decimals)).toString().padStart(decimals, '0');
  const text = decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Local money (minor units) for `tokens` base units at `priceUnits`, rounded down or up. */
export function fiatFor(
  tokens: bigint,
  priceUnits: bigint,
  tokenDecimals: number,
  currencyDecimals: number,
  round: 'down' | 'up',
): bigint {
  const numerator = tokens * priceUnits * pow10(currencyDecimals);
  const denominator = pow10(tokenDecimals) * pow10(P2P_PRICE_DECIMALS);
  return round === 'down'
    ? numerator / denominator
    : ceilDiv(numerator, denominator);
}

/** Token base units that `fiat` minor units buy at `priceUnits`, rounded down or up. */
export function tokensFor(
  fiat: bigint,
  priceUnits: bigint,
  tokenDecimals: number,
  currencyDecimals: number,
  round: 'down' | 'up',
): bigint {
  const numerator = fiat * pow10(tokenDecimals) * pow10(P2P_PRICE_DECIMALS);
  const denominator = priceUnits * pow10(currencyDecimals);
  return round === 'down'
    ? numerator / denominator
    : ceilDiv(numerator, denominator);
}

/** The contract's fees on a payment of `gross` to the buyer (rounded down, as it does). */
export function feesOn(
  gross: bigint,
  protocolFeeBps: number,
  integratorFeeBps: number,
): { protocolFee: bigint; integratorFee: bigint; net: bigint } {
  const protocolFee = (gross * BigInt(protocolFeeBps)) / P2P_BPS;
  const integratorFee = (gross * BigInt(integratorFeeBps)) / P2P_BPS;
  return {
    protocolFee,
    integratorFee,
    net: gross - protocolFee - integratorFee,
  };
}

export interface P2pPriceInput {
  side: P2pTradeSide;
  priceUnits: bigint;
  tokenDecimals: number;
  currencyDecimals: number;
  protocolFeeBps: number;
  integratorFeeBps: number;
  /** Exactly one of these two. */
  fiatUnits?: bigint;
  tokenUnits?: bigint;
}

export interface P2pPricedAmounts {
  /** Local money the trade is for, minor units. */
  fiatUnits: bigint;
  /** What the order locks. */
  grossTokens: bigint;
  protocolFee: bigint;
  integratorFee: bigint;
  /** What the buyer of the tokens receives. */
  netTokens: bigint;
}

/**
 * Prices one trade at one merchant's price. With `fiatUnits` the person names
 * the local money (a purchase: what they pay; a sale: what they receive);
 * with `tokenUnits` the gross token amount. Answers null when the amounts
 * round to nothing (no tokens, or nothing left after fees).
 */
export function priceTrade(input: P2pPriceInput): P2pPricedAmounts | null {
  const {
    side,
    priceUnits,
    tokenDecimals: td,
    currencyDecimals: cd,
    protocolFeeBps: fb,
    integratorFeeBps: ib,
  } = input;
  if (priceUnits <= 0n) return null;
  let gross: bigint;
  let fiat: bigint;
  if (input.tokenUnits !== undefined) {
    gross = input.tokenUnits;
    const { net } = feesOn(gross, fb, ib);
    // A purchase pays for the gross amount (rounded up: never short the
    // merchant); a sale is paid for the net amount (rounded down: never more
    // than the merchant receives).
    fiat =
      side === 'BUY'
        ? fiatFor(gross, priceUnits, td, cd, 'up')
        : fiatFor(net, priceUnits, td, cd, 'down');
  } else if (input.fiatUnits !== undefined) {
    fiat = input.fiatUnits;
    if (side === 'BUY') {
      gross = tokensFor(fiat, priceUnits, td, cd, 'down');
    } else {
      // The smallest gross whose net is worth at least `fiat`.
      const wantNet = tokensFor(fiat, priceUnits, td, cd, 'up');
      const keep = P2P_BPS - BigInt(fb) - BigInt(ib);
      if (keep <= 0n) return null;
      gross = ceilDiv(wantNet * P2P_BPS, keep);
      while (gross > 1n && feesOn(gross - 1n, fb, ib).net >= wantNet) {
        gross -= 1n;
      }
      while (feesOn(gross, fb, ib).net < wantNet) gross += 1n;
    }
  } else {
    return null;
  }
  const fees = feesOn(gross, fb, ib);
  if (gross <= 0n || fees.net <= 0n || fiat <= 0n) return null;
  return {
    fiatUnits: fiat,
    grossTokens: gross,
    protocolFee: fees.protocolFee,
    integratorFee: fees.integratorFee,
    netTokens: fees.net,
  };
}

/** The bond a bonded order asks of its buyer: `bps` of the amount, rounded down. */
export function bondFor(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / P2P_BPS;
}
