import { fromStroops } from '../swaps/swap-math';

/**
 * Integer math for AMM liquidity pool operations, in stroops (bigint) like
 * swap-math. Prices are the deposit ratio A/B expressed as a 7-decimal string —
 * the shape `Operation.liquidityPoolDeposit` accepts for minPrice/maxPrice.
 */
const PRICE_SCALE = 10_000_000n; // 7 decimal places, same as stroops

/**
 * The pool price (reserveA / reserveB) bracketed by a slippage tolerance:
 * `[price·(1−bps), price·(1+bps)]`, floor/ceil rounded so the window never
 * shrinks. Used as the deposit's on-chain min/max price bounds.
 */
export function priceBounds(
  reserveAStroops: bigint,
  reserveBStroops: bigint,
  slippageBps: number,
): { minPrice: string; maxPrice: string } {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  ) {
    throw new RangeError(
      `slippageBps must be an integer in [0, 10000], got ${slippageBps}`,
    );
  }
  if (reserveAStroops <= 0n || reserveBStroops <= 0n) {
    throw new RangeError('Price requires positive amounts on both sides');
  }
  const price = (reserveAStroops * PRICE_SCALE) / reserveBStroops;
  const min = (price * BigInt(10_000 - slippageBps)) / 10_000n;
  const maxNum = price * BigInt(10_000 + slippageBps);
  const max = (maxNum + 9_999n) / 10_000n; // ceil
  if (min <= 0n) {
    throw new RangeError(
      'The price of this pair is too small to express with 7 decimal places',
    );
  }
  return { minPrice: fromStroops(min), maxPrice: fromStroops(max) };
}

/**
 * The pool-ratio-matching counterpart of a deposit: given `amountA`, how much
 * of asset B the pool takes at the current reserves ratio (floor rounded).
 */
export function matchDeposit(
  amountAStroops: bigint,
  reserveAStroops: bigint,
  reserveBStroops: bigint,
): bigint {
  if (reserveAStroops <= 0n) {
    throw new RangeError('reserveA must be positive to derive the B amount');
  }
  return (amountAStroops * reserveBStroops) / reserveAStroops;
}

/**
 * A pool-share holder's proportional claim on one reserve:
 * `shares / totalShares · reserve`, floor rounded.
 */
export function proportionalShare(
  sharesStroops: bigint,
  totalSharesStroops: bigint,
  reserveStroops: bigint,
): bigint {
  if (totalSharesStroops <= 0n) {
    throw new RangeError('totalShares must be positive');
  }
  if (sharesStroops < 0n || sharesStroops > totalSharesStroops) {
    throw new RangeError('shares must be within [0, totalShares]');
  }
  return (sharesStroops * reserveStroops) / totalSharesStroops;
}
