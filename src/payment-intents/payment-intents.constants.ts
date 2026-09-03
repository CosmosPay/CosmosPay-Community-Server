/** Tuning knobs for the payment-intent on-chain observer. */

/**
 * How many intents are reconciled against Horizon at once.
 *
 * Each reconcile costs one Horizon call at minimum (`payments()`) and usually
 * two (a nested `transactions()` lookup per candidate payment), and Horizon
 * rate-limits per source IP. A serial loop wasted the whole tick on latency; an
 * unbounded `Promise.all` over a full batch would fire `2 × batchSize` requests
 * in one burst and trade a slow sweep for 429s — the worse of the two failures,
 * since a throttled batch makes no progress at all. Five in flight drains a
 * default 50-row batch in ten rounds while keeping the burst small, and leaves
 * headroom in the Prisma connection pool, one of whose connections is already
 * pinned by the surrounding advisory-lock transaction.
 */
export const RECONCILE_CONCURRENCY = 5;
