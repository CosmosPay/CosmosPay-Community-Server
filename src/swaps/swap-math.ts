export { fromStroops, toStroops } from '../common/stellar-amount';

/**
 * Fee taken from a source amount, in basis points (50 bps = 0.5%). Rounded down
 * so the platform never charges more than the stated rate.
 */
export function computeFee(sendStroops: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError(
      `feeBps must be an integer in [0, 10000], got ${feeBps}`,
    );
  }
  return (sendStroops * BigInt(feeBps)) / 10_000n;
}

/**
 * Slippage-protected minimum: the quote estimate reduced by `slippageBps`,
 * rounded down. This becomes the path payment's `destMin`, so the swap reverts
 * on-chain rather than delivering less than the caller agreed to accept.
 */
export function applySlippage(
  estimateStroops: bigint,
  slippageBps: number,
): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  ) {
    throw new RangeError(
      `slippageBps must be an integer in [0, 10000], got ${slippageBps}`,
    );
  }
  return (estimateStroops * BigInt(10_000 - slippageBps)) / 10_000n;
}
