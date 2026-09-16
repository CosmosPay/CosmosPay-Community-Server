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
 * The network's base reserve, in stroops: 0.5 XLM.
 *
 * An account must keep `(2 + subentries) × base reserve` of XLM that it cannot
 * spend, and every trustline — a pool-share trustline included — is a subentry.
 * The pre-flight affordability check prices that floor so a customer gets a
 * clear 400 naming the shortfall instead of signing an envelope the network then
 * rejects with `op_underfunded` / `op_low_reserve`.
 *
 * It is a protocol parameter, voted by validators rather than fixed by the
 * protocol, so it is kept in one place: if the network ever changes it, this is
 * the line to change.
 */
export const BASE_RESERVE_STROOPS = 5_000_000n;

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

/**
 * How many times one row's rejected envelope may be relayed again.
 *
 * `SignedTransactionRelay` re-sends a FAILED row's envelope on request, and each
 * re-send bumps `settlementEpoch` so its outcome can be announced: the terminal
 * webhook dedup key is `type:id:epoch`. Uncapped, that was a loop anyone holding
 * the envelope could run — POST the rejected envelope, get a fresh FAILED event,
 * its delivery rows and a Horizon submission, repeat — and the *unsigned*
 * envelope from the create response was enough to run it, because signatures do
 * not change a transaction's hash.
 *
 * Why three. A resubmission is always the same transaction — same sequence
 * number, fee and time bounds — so it can only succeed where the rejection was
 * fixable without rebuilding: a missing or wrong signature (`tx_bad_auth`, fixed
 * by signing with the right key or collecting a co-signer) or a source that
 * could not pay the fee (`tx_insufficient_balance`, fixed by topping it up).
 * Anything decided while applying the operations (`op_underfunded`,
 * `op_under_dest_min`, …) lands on-chain as a failed transaction and consumes
 * the sequence number, so no resubmission of it can ever succeed; the fix there
 * is a new envelope. Three covers both fixable causes with one to spare, and
 * holds a row to four FAILED events however hard it is driven.
 *
 * Enforced twice: the relay refuses up front with an error that says why, and
 * `SettlementRepository.markSubmitted` carries the bound in its compare-and-swap,
 * so concurrent resubmits cannot each read `epoch < cap` and all bump past it.
 */
export const SETTLEMENT_MAX_RESUBMITS = 3;
