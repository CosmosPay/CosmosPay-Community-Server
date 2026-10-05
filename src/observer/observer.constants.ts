/** Tuning knobs for the swap / liquidity-pool settlement observer. */

/**
 * The most in-flight rows a single consumer may put into one observer tick, per
 * table (swaps and liquidity pool operations are swept separately).
 *
 * The sweep used to take the oldest `OBSERVER_BATCH_SIZE` rows across every
 * tenant, so whoever had the most rows in flight owned the whole batch. That is
 * free to arrange: `POST /v1/swaps` and the pool deposit/withdraw routes build
 * and persist a row without anyone signing anything, they are reachable with the
 * shared public API key, and every anonymous caller is the same consumer. Each
 * row then costs a Horizon lookup per tick until its timebounds lapse, so a
 * flood starved every other tenant's settlement for as long as it lasted.
 *
 * Ten is a fifth of the default batch. With the round-robin ranking in the
 * sweep's query, at least five consumers are served per tick even when every one
 * of them is flooding, and one consumer's Horizon spend stays bounded at ten
 * lookups per table when nobody else is waiting — which keeps a lone flood from
 * burning the per-IP Horizon rate limit everyone shares. A consumer with more
 * rows than that is not stuck: the rest are picked up on later ticks, and
 * `submit` settles a row immediately without the observer.
 */
export const SETTLEMENT_MAX_ROWS_PER_CONSUMER = 10;

/**
 * How many observer intervals the sweep's advisory-lock transaction may stay
 * open, and the floor under that.
 *
 * The lock is transaction-scoped (`pg_try_advisory_xact_lock`), so the sweep
 * runs inside a database transaction for as long as its Horizon lookups take.
 * The bound is what keeps a hung Horizon call from holding that transaction —
 * and a pooled connection — open indefinitely. It has to be generous rather
 * than tight: a full batch is one lookup per `(network, txHash)` per table plus
 * a basis backfill, each allowed `HORIZON_TIMEOUT_MS`, and a sweep cut off by
 * its own timeout simply repeats that work on the next tick. Four intervals
 * leaves a slow cycle room to finish; one minute is the floor so a short
 * `OBSERVER_INTERVAL_MS` in development does not starve the sweep of time.
 */
export const SETTLEMENT_LOCK_TIMEOUT_INTERVALS = 4;
export const SETTLEMENT_LOCK_MIN_TIMEOUT_MS = 60_000;

/**
 * How far back the sweep re-checks FAILED rows against the ledger, by the row's
 * `createdAt`, and the most it re-checks per table per tick.
 *
 * FAILED used to be final as far as the observer was concerned: it selected only
 * PENDING/SUBMITTED. But a row could be recorded FAILED while its transaction
 * sat on-chain, settled — the wallet broadcast the envelope itself (SEP-7) and
 * the merchant's re-submission came back `tx_bad_seq` — and nothing ever looked
 * at it again: no success webhook, and for a deposit no cost basis, so the
 * commission on the position it opened was forfeited. The relay now asks the
 * ledger before it records FAILED; this re-check is what heals a row that was
 * recorded FAILED anyway, by an earlier release or a lookup that read a lagging
 * Horizon.
 *
 * A day, like the other rescue windows here: an envelope stops being valid
 * minutes after it is built, so by then its fate on the ledger is long fixed,
 * and the rest of the day is for Horizon to have answered at all. The batch is
 * its own, smaller budget so that re-checks never take lookups from rows still
 * in flight — FAILED rows are cheap to produce (any signature yields a
 * `tx_bad_auth`), and each one would otherwise be looked up every tick for the
 * whole window. Rows are dealt per consumer as the in-flight ones are
 * ({@link SETTLEMENT_MAX_ROWS_PER_CONSUMER}), newest first, since a fresh
 * failure is the one most likely to have been misread.
 */
export const SETTLEMENT_FAILED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const SETTLEMENT_FAILED_RECHECK_MAX_ROWS = 10;
