/** Tuning knobs for payment-intent verification and the on-chain observer. */

/**
 * How many intents are checked against Horizon at once — by the reconcile pass,
 * and by the expiry pass, which verifies each lapsed intent before expiring it.
 *
 * A check costs one Horizon call per page of payments it scans (the owning
 * transactions are joined into the page, see {@link PAYMENT_SCAN_MAX_PAGES}), or
 * two when it looks up a reported hash (the transaction, then its payments), and
 * Horizon rate-limits per source IP. A serial loop wasted the whole tick on
 * latency; an unbounded `Promise.all` over a full batch would fire every one of
 * those requests in one burst and trade a slow sweep for 429s — the worse of the
 * two failures, since a throttled batch makes no progress at all. Five in flight
 * drains a default 50-row batch in ten rounds while keeping the burst small, and
 * leaves headroom in the Prisma connection pool, one of whose connections is
 * already pinned by the surrounding advisory-lock transaction.
 */
export const RECONCILE_CONCURRENCY = 5;

/**
 * The most PENDING intents a single consumer may put into one observer tick.
 *
 * The sweep used to take the oldest `OBSERVER_BATCH_SIZE` rows across every
 * tenant, so whoever queued the most intents first owned the whole batch. That
 * is cheap to arrange: `POST /pay` is reachable with the shared public API key,
 * where every anonymous caller is the same consumer, and a scan of a busy
 * address costs up to {@link PAYMENT_SCAN_MAX_PAGES} Horizon calls. A flood
 * starved every real tenant's settlement detection for as long as it lasted.
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

/**
 * A Stellar transaction hash: a 32-byte SHA-256, hex-encoded.
 *
 * `PATCH /:id` took any string of up to 128 characters as `txHash` and stored it
 * unverified, so the column held values no ledger can contain. Either case is
 * accepted on input and the hash is stored lowercase — the spelling Horizon
 * reports, and the one swaps and liquidity operations store
 * (`Buffer.toString('hex')`) — so one transaction is one value in the
 * `(consumerId, txHash)` unique index rather than two that differ by case.
 */
export const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Payments per page when the verifier scans an intent's destination: Horizon's
 * maximum `limit`.
 *
 * A page is one Horizon call however many of its payments are candidates,
 * because the owning transactions are joined into it, so the larger the page the
 * fewer calls a scan spends reaching the intent's creation time.
 */
export const PAYMENT_SCAN_PAGE_SIZE = 200;

/**
 * The most pages of payments the verifier walks back through, newest first,
 * looking for an intent's payment.
 *
 * The scan used to read one page of the 50 newest payments and stop. Anyone can
 * pay any account, so about 50 dust payments landing after the real one pushed
 * it off that page: the observer never found it, and the intent expired
 * although it was paid. The scan now pages back until it reaches payments older
 * than the intent ({@link TX_CREATED_AT_SKEW_MS}), which is as far back as the
 * real payment can be.
 *
 * That still needs a bound, because a flood is cheap: one transaction carries up
 * to 100 payment operations, so a thousand records cost about 0.01 XLM in fees,
 * and every tenant's sweep shares one per-IP Horizon rate limit. Five pages is
 * the 1,000 newest payments to the destination, at most five calls per scan.
 *
 * Running out of pages is reported as no match, and at expiry that expires the
 * intent. Treating it as "unknown" instead would let the same 0.01 XLM pin an
 * intent PENDING forever and hold its slot in every expiry pass after — fifty of
 * them and nobody's intents expire. A destination that busy is not stuck:
 * `POST /:id/validate` with the transaction hash settles the intent without
 * scanning, EXPIRED included.
 */
export const PAYMENT_SCAN_MAX_PAGES = 5;

/**
 * Budget for `POST /v1/payment-intents/tx` and `POST /v1/payment-intents/pay`,
 * per consumer + client address.
 *
 * One bucket for both: they are two spellings of the same step — build the
 * payment for an intent — and a wallet uses whichever its flow calls for, never
 * both at once.
 *
 * Each call resolves the intent, reads the payer's account from Horizon and
 * builds an envelope. Both take the shared public API key, under which every
 * anonymous wallet is one consumer, so the client address is the only thing
 * separating them and the Horizon budget they share is what a loop here spends.
 *
 * Thirty a minute is a wallet rebuilding while the customer picks an asset, then
 * signing: comfortably above one checkout, and several at once from a NAT.
 */
export const PAYMENT_INTENT_BUILD_RATE_LIMIT = {
  name: 'payment-intents:build',
  limit: 30,
  windowMs: 60 * 1000,
};
