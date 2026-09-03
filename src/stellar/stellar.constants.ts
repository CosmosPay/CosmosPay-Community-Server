/**
 * Stellar protocol constants and Horizon tuning knobs.
 *
 * The precision values below were previously copied into `swaps/swap-math.ts`,
 * `liquidity-pools/lp-math.ts` and `common/money.ts` — three spellings of one
 * protocol rule, so a change had three places to be made and two to be
 * forgotten. They live here now and are imported from all three.
 */

/** Stellar's fixed precision: 7 decimal places. */
export const STELLAR_DECIMALS = 7;

/** 1 unit = 10^7 stroops. Integer math is done in stroops to avoid floats. */
export const STROOP_SCALE = 10_000_000n;

/** int64 max — Stellar's amount ceiling, in stroops. */
export const MAX_STROOPS = (1n << 63n) - 1n;

/** A non-negative decimal with at most `STELLAR_DECIMALS` places. */
export const STELLAR_AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

/** Largest value a Stellar MEMO_ID can hold. */
export const MAX_UINT64 = 18446744073709551615n;

/**
 * The SDK ships with `timeout: 0` — no timeout at all — on every Horizon read.
 * A stalled socket therefore hangs the caller forever, which matters most in the
 * background reconcilers: they guard each tick with a `running` latch that is
 * only cleared in a `finally`, so one hung request silently stops settlement on
 * that instance for good. Bound every Horizon call instead.
 *
 * This has to be set on each `Horizon.Server`'s own HTTP client. The obvious
 * `Config.setTimeout()` looks global but is not: in this SDK version only
 * `federation/server` and `stellartoml` ever call `Config.getTimeout()`, and
 * `horizon_axios_client.createHttpClient()` builds its client with headers and
 * no timeout at all — so the global setter left every Horizon read unbounded
 * while reading as if it had fixed exactly this. `server.httpClient` is a
 * documented, mutable escape hatch in the SDK's own JSDoc.
 *
 * `submitTransaction` passes its own longer per-request timeout, which takes
 * precedence over this default, so transaction submission is unaffected.
 */
export const HORIZON_TIMEOUT_MS = 15_000;
