/**
 * Tuning knobs for payment-intent verification and the on-chain observer, and
 * the designs a hosted checkout page may be shown in.
 */

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

/** A Solana transaction signature: 64 bytes in base58, 86–88 characters. */
export const SOLANA_TX_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

/** A Monad (EVM) transaction hash: 0x + 32 bytes in hex. */
export const EVM_TX_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** A hex transaction id of either shape — the ones stored lowercase. */
export const HEX_TX_ID_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

/**
 * Any chain's transaction id, as the request DTOs accept it: they do not know
 * the intent's chain, so the shape is checked against it in the service.
 */
export const ANY_TX_ID_RE =
  /^(?:[0-9a-fA-F]{64}|0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{80,90})$/;

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

/**
 * Budget for `GET /v1/payment-links/{id}`, the hosted checkout's anonymous read,
 * per client address (an IPv6 caller per /64).
 *
 * The route is `@Public()`, so there is no consumer to key on: every caller is
 * the same `anonymous` subject and the address is the whole budget. That is why
 * this policy must stay `per: 'address'` (the default) — a `consumer` budget
 * here would be ONE bucket for every payer on the internet.
 *
 * Sixty a minute is five checkout tabs' worth: a page polling every 5 s spends
 * 12, so one payer can poll, reload a few times and open the link on a second
 * device behind the same router, and a handful of payers behind one NAT (a
 * shop's Wi-Fi) still fit. The fixed window lets a caller spend up to twice this
 * across a boundary, which is still only two reads a second.
 *
 * What it bounds is guessing and scraping, not load — APISIX shapes traffic.
 * Each request is a primary-key read and a QR render, and at this rate an
 * address cannot get meaningfully closer to guessing an id (a cuid carries
 * about 41 random bits besides its timestamp and counter). Raise it if a
 * carrier-grade NAT puts many payers behind one IPv4 address; the client should
 * honour `Retry-After` either way.
 */
export const PAYMENT_LINK_READ_RATE_LIMIT = {
  name: 'payment-links:read',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * `POST /v1/payment-links/{id}/transaction`, per client address: each call
 * reads the payer's account from Horizon (and the merchant's, for an issued
 * asset) and builds an envelope. A payer builds one, maybe again after a
 * timeout lapses; twenty a minute is a checkout retrying many times over.
 */
export const PAYMENT_LINK_TRANSACTION_RATE_LIMIT = {
  name: 'payment-links:transaction',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * The most older intents a settlement asks the chain about before it claims a
 * transaction (`settlement-rivals.ts`): rivals of other consumers that the same
 * payment may also pay, and that therefore outrank the intent being settled.
 * Each one costs a verifier call, so this is the bound on those calls.
 *
 * Only the OLDEST this many are asked about, and if none of them is paid the
 * intent settles; rivals past them are left to the claim, first come. A count
 * never refuses a settlement. It used to: past the cap the intent was refused
 * without asking the chain, so six junk intents at a merchant's address
 * refused every settlement the merchant made after them. Oldest first, because
 * that is the order precedence runs in: an original is the oldest intent its
 * payment pays, so it is in the window unless more than this many older ones
 * describe the same payment — which, for a rival to be admitted at all, means
 * the same memo, destination, asset and amount (`SETTLEMENT_RIVAL_FILTERS`).
 */
export const SETTLEMENT_RIVALS_MAX = 5;

/**
 * The prebuilt designs a payment intent's hosted checkout page
 * (`https://payments.cosmospay.lat/<id>`) can be shown in. The merchant picks
 * one per intent (`checkoutTheme` on create and on `PATCH`), and both the
 * owner's reads and the public `GET /v1/payment-links/{id}` answer it, so the
 * page renders the design without knowing who the merchant is.
 *
 * Stored as a plain string, like `chain`, so adding a design is an entry here
 * and a page that can draw it — no migration. Removing one is safe too: a
 * stored value no longer listed reads as {@link DEFAULT_CHECKOUT_THEME}.
 */
export const CHECKOUT_THEMES = ['classic', 'split', 'ticket', 'card'] as const;
export type CheckoutTheme = (typeof CHECKOUT_THEMES)[number];

/** The design an intent that names none is shown in (stored as null). */
export const DEFAULT_CHECKOUT_THEME: CheckoutTheme = 'classic';

export function isCheckoutTheme(value: unknown): value is CheckoutTheme {
  return (
    typeof value === 'string' &&
    (CHECKOUT_THEMES as readonly string[]).includes(value)
  );
}

/**
 * The design a stored intent is shown in: its own, or the default when it
 * names none (null) or one this release no longer draws. Every response says
 * the design outright, so no client has to know what null means.
 */
export function effectiveCheckoutTheme(stored: string | null): CheckoutTheme {
  return isCheckoutTheme(stored) ? stored : DEFAULT_CHECKOUT_THEME;
}
