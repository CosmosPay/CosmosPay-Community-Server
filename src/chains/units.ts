/**
 * Decimal amounts ↔ integer base units (lamports, wei, a token's smallest
 * unit), for any number of decimals. `toStroops` does the same for Stellar's
 * fixed 7; this is the general form the other chains need, and for the same
 * reason: an amount that decides whether a payment settles an intent is
 * compared as an exact bigint, never as a float64.
 */

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** How many decimal places `amount` is written with. */
export function decimalPlaces(amount: string): number {
  const match = DECIMAL_RE.exec(amount);
  return match?.[2]?.length ?? 0;
}

/**
 * `"1.5"` with 6 decimals → `1500000n`. Throws on anything that is not a plain
 * non-negative decimal, or that has more places than `decimals` — truncating
 * those would quietly ask for a different amount than the caller wrote.
 */
export function parseUnits(amount: string, decimals: number): bigint {
  const match = DECIMAL_RE.exec(amount);
  if (!match) {
    throw new Error(`"${amount}" is not a decimal amount`);
  }
  const [, whole, fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new Error(`"${amount}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/** `1500000n` with 6 decimals → `"1.5"`: trailing zeros dropped, never a float. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}
