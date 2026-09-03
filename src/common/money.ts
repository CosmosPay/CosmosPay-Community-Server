/**
 * Formatting for money that has been summed by PostgreSQL.
 *
 * Stellar amounts are stored as exact decimal strings, so aggregating them
 * requires an `::numeric` cast in SQL (Prisma's `_sum` cannot express it on a
 * `String` column). What comes back from the driver is a `numeric`, which
 * surfaces as a string — or, depending on the driver and the column, as a
 * `Decimal`-like object or a `bigint`.
 *
 * The one thing this must never do is round-trip through `Number`. Moving the
 * aggregation into the database is precisely what removes float error from the
 * total; parsing the exact result back into a float64 to re-format it would put
 * that error straight back. So the trimming happens in string space.
 */

import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';

/**
 * Formats a value returned by a `SUM(...::numeric)` as a Stellar amount:
 * at most 7 decimal places, trailing zeros dropped, never via a float.
 *
 * `null`/`undefined` become `'0'` — `SUM` over no rows is NULL, which is a
 * legitimate "nothing settled yet", not an error. Anything that does not look
 * like a decimal number also becomes `'0'` rather than throwing: these values
 * feed dashboard aggregates, where one unexpected row must not take the whole
 * response down. (Blind `String(value)` is what this replaces — on an object it
 * silently yields `'[object Object]'`.)
 */
export function formatNumericAmount(value: unknown): string {
  const raw = numericToString(value);
  if (raw === null) return '0';

  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const trimmed = fraction.slice(0, STELLAR_DECIMALS).replace(/0+$/, '');
  const body = trimmed ? `${whole}.${trimmed}` : whole;

  // Never render "-0".
  if (negative && /^0(\.0*)?$/.test(body)) return '0';
  return negative ? `-${body}` : body;
}

/** `COUNT(*)` is a bigint; drivers surface it as a bigint, number or string. */
export function toCount(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Narrows a driver-returned numeric to its decimal string, or null when it is
 * not one. Handles the `Decimal`-like case explicitly rather than relying on
 * `String()`, so an unexpected object is rejected instead of stringified to
 * `'[object Object]'`.
 */
function numericToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  let text: string | null;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    text = value.toString();
  } else {
    // Decimal.js / pg-numeric wrappers define their own toString.
    text = customToString(value);
  }

  if (text === null) return null;
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

/**
 * Stringifies an object only when it overrides `toString`.
 *
 * Anything inheriting `Object.prototype.toString` would yield
 * `'[object Object]'` — exactly the silent corruption this module exists to
 * prevent — so it returns null instead. The override is invoked through the
 * captured function rather than as `value.toString()` so that nothing here can
 * fall back to the default stringification.
 */
function customToString(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate: unknown = (value as { toString?: unknown }).toString;
  if (typeof candidate !== 'function') return null;
  if (candidate === (Object.prototype.toString as unknown)) return null;
  const text: unknown = (candidate as () => unknown).call(value);
  return typeof text === 'string' ? text : null;
}
