import { Logger } from '@nestjs/common';

const DECIMALS = 7;
const STROOP = 10_000_000n;
const MAX_STROOPS = (1n << 63n) - 1n;
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;
const logger = new Logger('StellarAmount');

/** Parses a decimal Stellar amount into stroops. Throws on invalid input. */
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

/**
 * Parses an amount read from persistent storage. Legacy malformed values are
 * logged and contribute zero instead of breaking the enclosing API request.
 */
export function parseAmountOrZero(amount: string | null | undefined): bigint {
  try {
    if (typeof amount !== 'string') {
      throw new RangeError('amount is null or undefined');
    }
    return toStroops(amount);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Ignoring invalid stored Stellar amount: ${reason}`);
    return 0n;
  }
}

/** Formats stroops as a decimal string, trimming trailing fractional zeros. */
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
 * Formats an aggregate in the customers API contract: exactly seven decimal
 * places, never exponential notation. Unlike `fromStroops`, it keeps zeros.
 */
export function formatFixed7(stroops: bigint): string {
  if (stroops < 0n) {
    throw new RangeError('Cannot format a negative amount');
  }
  const whole = stroops / STROOP;
  const frac = (stroops % STROOP).toString().padStart(DECIMALS, '0');
  return `${whole}.${frac}`;
}
