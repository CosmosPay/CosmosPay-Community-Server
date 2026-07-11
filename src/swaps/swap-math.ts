/**
 * Decimal arithmetic for Stellar amounts, done in integer "stroops" so fee and
 * slippage math never touches floating point. Stellar amounts have a fixed
 * precision of 7 decimal places (1 unit = 10,000,000 stroops), and the maximum
 * amount is (2^63 - 1) stroops — both enforced here.
 */
const DECIMALS = 7;
const STROOP = 10_000_000n; // 10^7
const MAX_STROOPS = (1n << 63n) - 1n; // int64 max — Stellar's amount ceiling
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

/** Parses a decimal amount string into stroops (bigint). Throws on bad input. */
export function toStroops(amount: string): bigint {
  if (!AMOUNT_RE.test(amount)) {
    throw new RangeError(
      `Invalid amount "${amount}": expected a non-negative decimal with up to ${DECIMALS} places`,
    );
  }
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = frac.padEnd(DECIMALS, '0');
  const stroops = BigInt(whole) * STROOP + BigInt(fracPadded);
  if (stroops > MAX_STROOPS) {
    throw new RangeError(
      `Amount "${amount}" exceeds the maximum Stellar amount`,
    );
  }
  return stroops;
}

/** Formats stroops (bigint) back into a Stellar amount string (trims trailing zeros). */
export function fromStroops(stroops: bigint): string {
  if (stroops < 0n) {
    throw new RangeError('Cannot format a negative amount');
  }
  const whole = stroops / STROOP;
  const frac = (stroops % STROOP).toString().padStart(DECIMALS, '0');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

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
