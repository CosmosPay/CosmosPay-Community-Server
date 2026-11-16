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
/**
 * What a wallet shows for a Solana Pay transaction request (its GET): who asks
 * for the payment, and an icon (an absolute https image, served by the hosted
 * checkout's site on every domain).
 */
export const SOLANA_PAY_LABEL = 'Cosmos Pay';
export const SOLANA_PAY_ICON_PATH = '/android-chrome-512x512.png';

/**
 * `POST /v1/payment-links/{id}/events`, per client address: a checkout reports a
 * handful of wallet events per payment (opened, closed, sent); thirty a minute is a
 * payer opening their wallet again and again.
 */
export const PAYMENT_LINK_EVENT_RATE_LIMIT = {
  name: 'payment-links:events',
  limit: 30,
  windowMs: 60 * 1000,
};

/** What the hosted checkout reports about the payer's wallet. */
export const CHECKOUT_EVENTS = [
  'walletOpened',
  'walletClosed',
  'sent',
] as const;
export type CheckoutEvent = (typeof CHECKOUT_EVENTS)[number];

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

// ── Payments from any network (deposit addresses) ───────────────────────────

/**
 * What a token is named by on a network other than Stellar, Solana and Monad,
 * as `assetIssuer` takes it: the contract the cross-chain route lists, which is
 * not always an address (a Sui coin type, a NEAR account id). Printable ASCII
 * with no space, bounded; the service accepts only a value the route lists.
 */
export const PAYMENT_TOKEN_ID_RE = /^[\x21-\x7e]{1,200}$/;

/**
 * `GET /v1/payment-links/{id}/deposit-assets`, per client address. The list is
 * the cross-chain route's cached token list: a checkout reads it once per visit,
 * perhaps again after a reload. Thirty a minute is a payer reloading over and
 * over.
 */
export const PAYMENT_DEPOSIT_ASSETS_RATE_LIMIT = {
  name: 'payment-links:deposit-assets',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * `POST /v1/payment-links/{id}/quote`, per client address. Each call is a dry
 * quote at the cross-chain route, a solver auction counted against the one
 * partner key the deployment shares, from a route with no key of its own.
 * Thirty a minute is a payer trying network after network.
 */
export const PAYMENT_DEPOSIT_QUOTE_RATE_LIMIT = {
  name: 'payment-links:quote',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * `POST /v1/payment-links/{id}/deposits`, per client address. Each one is a live
 * quote that makes a deposit address and a row the observer polls until it
 * settles or its deadline (plus the rescue window) passes. Ten a minute is a
 * payer changing their mind several times; the per-client cap below bounds how
 * many of them stay open on one link.
 */
export const PAYMENT_DEPOSIT_CREATE_RATE_LIMIT = {
  name: 'payment-links:deposits',
  limit: 10,
  windowMs: 60 * 1000,
};

/**
 * `GET /v1/payment-links/{id}/deposits/{depositId}`, per client address: the page
 * polls it every few seconds beside the link itself, which has its own bucket.
 * The same sixty a minute as the link read, for the same reasons.
 */
export const PAYMENT_DEPOSIT_READ_RATE_LIMIT = {
  name: 'payment-links:deposit-read',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * The most deposit addresses one CLIENT (an IPv4 address, or an IPv6 /48:
 * `paymentDepositClientSubject`) may have open on one payment link at once,
 * waiting for a deposit or with one in progress. A payer needs one; two cover
 * changing network or asset once.
 *
 * This is the cap a caller meets first. The link id is the only capability
 * these routes take, so a cap shared by everyone holding it, alone, was a
 * lockout: anyone could open the link's slots with addresses nobody pays and
 * keep the real payer out until they expired. Per client, a caller fills only
 * its own two.
 */
export const PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT = 2;

/**
 * How many NEW deposit addresses one payment link takes per
 * {@link PAYMENT_DEPOSIT_LINK_WINDOW_MS}, from all clients together: a creation
 * budget that refills, never a count of open deposits. It bounds what one link
 * can cost upstream (deposit addresses, rows the observer polls) when a caller
 * rotates addresses past the per-client cap. Past it a create is `429` with
 * `Retry-After` until the oldest creation leaves the window, so spending it
 * delays payers for minutes at most and locks nobody out: a hard cap on open
 * deposits did, for as long as they lived. Twenty in five minutes is far
 * beyond honest payers sharing a link.
 */
export const PAYMENT_DEPOSIT_LINK_BUDGET = 20;

/** The sliding window {@link PAYMENT_DEPOSIT_LINK_BUDGET} counts in. */
export const PAYMENT_DEPOSIT_LINK_WINDOW_MS = 5 * 60 * 1000;

/**
 * How many leading hextets of an IPv6 address make one deposit client: three,
 * a /48. Wider than the rate limits' /64 on purpose: a /48 is what one site or
 * one hosting customer is routinely given, so rotating through its 65,536 /64s
 * costs nothing and must not buy 65,536 times the per-client cap.
 */
export const PAYMENT_DEPOSIT_CLIENT_IPV6_HEXTETS = 3;

/**
 * How long a slot reserved for a deposit being opened is held, at least. A slot
 * is reserved under the link's lock BEFORE the live quote (which takes up to
 * NEAR_INTENTS_TIMEOUT_MS) and released once the deposit row exists or the
 * quote failed; this lifetime only matters when the process died in between, so
 * a slot is never lost for longer than this. The service holds it for three
 * quote timeouts when that is longer.
 */
export const PAYMENT_DEPOSIT_RESERVATION_MIN_MS = 2 * 60 * 1000;

/**
 * The first key of the transaction-scoped advisory lock that serializes the
 * deposit slots of one payment link (`pg_advisory_xact_lock(class, hashtext(id))`).
 * The two-key form, so it can never meet a job lock (`AdvisoryLockKey`, one
 * 64-bit key); this class is the deposits' alone.
 */
export const PAYMENT_DEPOSIT_LOCK_CLASS = 881_022;

/**
 * What a client's address is stored as on a deposit: HMAC-SHA256 under a key
 * derived from APISIX_GATEWAY_SECRET with this salt and label, never the address
 * itself. Equal for one client, so the per-client cap can count it; useless to
 * anyone who reads the table without the secret.
 */
export const PAYMENT_DEPOSIT_CLIENT_KEY_SALT = 'cosmos-pay payment-deposit';
export const PAYMENT_DEPOSIT_CLIENT_KEY_LABEL = 'payment-deposit client v1';

/**
 * A new deposit request for the same origin asset and refund address returns
 * the open one instead of making another, while that one still has at least
 * this long before its deadline: enough to send from a wallet. A reload of the
 * checkout then shows the same address rather than a new one.
 */
export const PAYMENT_DEPOSIT_REUSE_MIN_REMAINING_MS = 10 * 60 * 1000;

/** The most deposits the owner's list of one payment intent answers, newest first. */
export const PAYMENT_DEPOSIT_OWNER_LIST_MAX = 50;

/**
 * The most a merchant may raise a link's per-payer cap to (`depositLimits.perPayer`;
 * the default is {@link PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT}). A kiosk or an event
 * behind one network may need more than two; past ten, one address could hold a
 * link's whole creation budget.
 */
export const PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT_CEILING = 10;

/**
 * The most a merchant may raise a link's creation budget to
 * (`depositLimits.perWindow`, per {@link PAYMENT_DEPOSIT_LINK_WINDOW_MS}; the default
 * is {@link PAYMENT_DEPOSIT_LINK_BUDGET}). Each new deposit is a live quote and a row
 * the observer polls for a day; two hundred in five minutes is a busy event, and
 * the most one link may cost upstream.
 */
export const PAYMENT_DEPOSIT_LINK_BUDGET_CEILING = 200;

/**
 * The origins a link's amount is checked against at creation, and for the
 * checkout (`PaymentRouteProbe`): the stablecoins most payers hold, on the
 * networks they most hold them on, plus Bitcoin. Each is one dry quote; routes
 * have minimums of their own (a Tron route has asked for $100, Bitcoin's bridge a
 * minimum in BTC), and a payer should not find that out after picking one.
 */
export const PAYMENT_ROUTE_PROBE_ORIGINS = [
  { chain: 'eth', asset: 'USDC' },
  { chain: 'base', asset: 'USDC' },
  { chain: 'arb', asset: 'USDC' },
  { chain: 'pol', asset: 'USDC' },
  { chain: 'solana', asset: 'USDC' },
  { chain: 'bsc', asset: 'USDT' },
  { chain: 'tron', asset: 'USDT' },
  { chain: 'btc', asset: 'BTC' },
] as const;

/**
 * The refund address a probe's dry quote names: one the route accepts on each
 * probed network, for a quote that reserves nothing and can never refund. The EVM
 * and Solana ones are derived from sha256("cosmos pay route probe") (keccak for
 * the EVM address), so nobody holds a key to them; the route refuses the
 * well-known burn addresses there. Tron's and Bitcoin's are their well-known
 * burn addresses, which it accepts.
 */
export const PAYMENT_ROUTE_PROBE_REFUND_TO: Record<
  (typeof PAYMENT_ROUTE_PROBE_ORIGINS)[number]['chain'],
  string
> = {
  eth: '0x9a5A2B9540E1AE4FCAabaAebFFe90D6737d8299E',
  base: '0x9a5A2B9540E1AE4FCAabaAebFFe90D6737d8299E',
  arb: '0x9a5A2B9540E1AE4FCAabaAebFFe90D6737d8299E',
  pol: '0x9a5A2B9540E1AE4FCAabaAebFFe90D6737d8299E',
  bsc: '0x9a5A2B9540E1AE4FCAabaAebFFe90D6737d8299E',
  solana: 'C8cxhxckoW7AyUCvyiZnXCPAUsAeUWz5EDtrpzDAs891',
  tron: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  btc: '1BitcoinEaterAddressDontSendf59kuE',
};

/**
 * How long a probe's answer for one asset and amount is reused, and how many such
 * answers are kept. Minimums move slowly; ten minutes keeps a busy link's checkout
 * from costing eight quotes per visitor.
 */
export const PAYMENT_ROUTE_PROBE_TTL_MS = 10 * 60 * 1000;
export const PAYMENT_ROUTE_PROBE_MAX_ENTRIES = 2000;

/** `GET /v1/payment-intents/{id}/route-check`, per consumer and client address. */
export const PAYMENT_ROUTE_CHECK_RATE_LIMIT = {
  name: 'payment-intents:route-check',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * `POST /v1/payment-links/{id}/payer`, per client address: the checkout records
 * the payer's email once before showing how to pay, maybe again after a typo.
 */
export const PAYMENT_LINK_PAYER_RATE_LIMIT = {
  name: 'payment-links:payer',
  limit: 10,
  windowMs: 60 * 1000,
};

/** The languages a receipt is written in: the checkout's, English otherwise. */
export const RECEIPT_LANGS = [
  'en',
  'es',
  'pt',
  'fr',
  'de',
  'hi',
  'zh',
] as const;
export type ReceiptLang = (typeof RECEIPT_LANGS)[number];

/**
 * How long a replica's claim on sending one receipt lasts. Past it another replica
 * (or the next sweep) may send it: a send that died mid-way is retried, at the cost
 * of a rare second copy, which beats a receipt that never goes out.
 */
export const PAYMENT_RECEIPT_CLAIM_MS = 5 * 60 * 1000;

/**
 * How far back the receipt sweeper looks for a settled payment whose receipt has
 * not gone out (the mailer down, a pod killed): three days, then it gives up and
 * logs, rather than mailing a payer about last month.
 */
export const PAYMENT_RECEIPT_RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Receipts the sweeper sends per tick. */
export const PAYMENT_RECEIPT_SWEEP_BATCH = 25;

/**
 * How far back the receipt limits count. A receipt goes to an address the
 * payer typed and nobody verified, so the mail this service sends to any one
 * address, and on behalf of any one merchant, is bounded per day.
 */
export const PAYMENT_RECEIPT_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Receipts one address gets per window, from every merchant together. A real
 * payer rarely pays more than a handful of links a day; past this, someone is
 * using payments to mail an address that never asked. A receipt over the limit
 * is held, not dropped: the sweeper sends it once the window allows, within
 * `PAYMENT_RECEIPT_RETRY_WINDOW_MS`.
 */
export const PAYMENT_RECEIPT_MAX_PER_RECIPIENT = 10;

/**
 * Receipts one merchant (one consumer) sends per window. Bounds an account set
 * up to mail many addresses with tiny payments; held like the per-recipient
 * limit. A merchant that outgrows it is a support conversation, not a default.
 */
export const PAYMENT_RECEIPT_MAX_PER_MERCHANT = 1000;

/**
 * The first key of the transaction-scoped advisory lock that serializes the
 * receipt limits of one recipient (`pg_advisory_xact_lock(class, hashtext(email))`),
 * so two replicas cannot both take the last receipt of an address's day. The
 * two-key form, like `PAYMENT_DEPOSIT_LOCK_CLASS`: never a job lock.
 */
export const PAYMENT_RECEIPT_LOCK_CLASS = 881_025;
