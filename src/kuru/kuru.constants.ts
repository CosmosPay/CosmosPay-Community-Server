/** Constants for Kuru Flow, Monad's swap aggregator. */

/**
 * Kuru Flow's name for native MON: the zero address, which is what its quote
 * API takes as `tokenIn` / `tokenOut` (checked 2026-09-30 — the `0xEeee…`
 * convention other aggregators use finds no route).
 */
export const KURU_NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/**
 * The address a quote is priced for when the caller names no wallet. Kuru
 * requires one; the route it finds does not depend on it, and building a real
 * swap always uses the caller's own.
 */
export const KURU_QUOTE_ADDRESS = '0x0000000000000000000000000000000000000001';

/**
 * How many keyless JWTs are kept, one per user address. A token is a few
 * hundred bytes; the cap only stops a stream of distinct addresses from
 * growing the map without bound.
 */
export const KURU_TOKEN_CACHE_MAX = 1000;

/**
 * Seconds before a keyless JWT's expiry at which it is replaced, so a quote
 * never goes out with a token that lapses in flight.
 */
export const KURU_TOKEN_REFRESH_MARGIN_S = 60;
