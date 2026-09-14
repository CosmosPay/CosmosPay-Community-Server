/** Tuning knobs for payment-intent verification and the on-chain observer. */

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

/**
 * The most PENDING intents a single consumer may put into one observer tick.
 *
 * The sweep used to take the oldest `OBSERVER_BATCH_SIZE` rows across every
 * tenant, so whoever queued the most intents first owned the whole batch. That
 * is cheap to arrange: `POST /pay` is reachable with the shared public API key,
 * where every anonymous caller is the same consumer, and an open-amount intent
 * to a busy address costs up to ~51 Horizon calls to scan. A flood starved every
 * real tenant's settlement detection for as long as it lasted.
 *
 * Ten is a fifth of the default batch. Combined with the round-robin ranking in
 * the observer's query, at least five consumers are served per tick even when
 * every one of them is flooding, and one consumer's Horizon spend per tick stays
 * bounded at ten scans when nobody else is waiting — which also keeps a lone
 * flood from burning the per-IP Horizon rate limit everyone else shares. A
 * merchant with more pending intents than that is not stuck: the rest are
 * picked up on later ticks, and `POST /:id/validate` settles one immediately.
 */
export const OBSERVER_MAX_INTENTS_PER_CONSUMER = 10;

/**
 * How long before an intent's `createdAt` a transaction may have closed and
 * still count as that intent's payment.
 *
 * A payment is built after its intent exists — the TX envelope comes out of this
 * service, the PAY link is scanned off a QR this service just returned — so an
 * honest ledger closes after `createdAt`. With no floor at all, an old payment
 * that happened to carry the same memo, destination and amount (a previous
 * intent's, under a memo that was later reused) settled a brand-new intent.
 *
 * The allowance exists only for clock disagreement: `createdAt` is stamped by
 * this host, a ledger's close time by the validators. Stellar Core itself
 * refuses a proposed close time more than 60 s ahead of a validator's clock
 * (`MAX_TIME_SLIP_SECONDS`), so a minute is the drift the network already
 * treats as normal. Anything wider re-opens the window this closes: an older
 * payment only slips through if it landed within that minute before the intent.
 */
export const TX_CREATED_AT_SKEW_MS = 60_000;
