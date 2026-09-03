/** Tuning knobs for the rate limiter itself. Per-route budgets live with the routes. */

/**
 * Response headers. The `RateLimit-*` triple is the IETF draft spelling, which
 * is what an HTTP client library will already look for; `Retry-After` is the
 * RFC 9110 one and is the only header a browser or a naive retry loop honours.
 * Both are sent, because the two audiences are different.
 */
export const RATE_LIMIT_HEADER = {
  limit: 'ratelimit-limit',
  remaining: 'ratelimit-remaining',
  reset: 'ratelimit-reset',
  retryAfter: 'retry-after',
} as const;

/**
 * Counters deleted per prune tick. The table only holds live and just-expired
 * windows, so this is small; a bounded `deleteMany` keeps each tick's lock short
 * and lets the loop catch up after an outage instead of taking one huge lock.
 */
export const RATE_LIMIT_PRUNE_BATCH_SIZE = 5_000;

/**
 * How long an expired window is kept before the prune removes it. Not zero, so
 * a counter is never deleted out from under a request that is mid-flight in the
 * final milliseconds of its window and about to increment it.
 */
export const RATE_LIMIT_GRACE_MS = 60_000;
