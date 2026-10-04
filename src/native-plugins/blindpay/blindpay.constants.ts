import type { BlindpayEnvironment } from '@/config/configuration';

/**
 * Enumerations mirrored from the BlindPay API. Kept as `as const` tuples so they
 * double as runtime allow-lists for class-validator (`@IsIn`) and as TypeScript
 * union types. We persist these values as plain strings, so adding a new provider
 * value here never requires a database migration.
 */

// Blockchain networks BlindPay settles on (production + testnet/development).
export const BLINDPAY_NETWORKS = [
  'ethereum',
  'base',
  'arbitrum',
  'polygon',
  'stellar',
  'solana',
  'tron',
  'sepolia',
  'base_sepolia',
  'arbitrum_sepolia',
  'polygon_amoy',
  'stellar_testnet',
  'solana_devnet',
] as const;
export type BlindpayNetwork = (typeof BLINDPAY_NETWORKS)[number];

// Stablecoins BlindPay mints/accepts. USDB is the mintable test token (dev only).
export const BLINDPAY_TOKENS = ['USDC', 'USDT', 'USDB'] as const;
export type BlindpayToken = (typeof BLINDPAY_TOKENS)[number];

// Bank rails a payout can settle to / a payin can be funded from.
export const BLINDPAY_RAILS = [
  'wire',
  'ach',
  'rtp',
  'pix',
  'pix_safe',
  'ted',
  'spei_bitso',
  'transfers_bitso',
  'ach_cop_bitso',
  'international_swift',
  'sepa',
] as const;
export type BlindpayRail = (typeof BLINDPAY_RAILS)[number];

// Payin (onramp) payment methods. NOTE: this enum differs from the payout
// `BLINDPAY_RAILS` — payins drop the `_bitso` suffix (`spei`/`transfers`) and
// Colombia is `pse` (vs the payout rail `ach_cop_bitso`). Verified live against
// the API: `/payin-quotes` rejects the `_bitso` rails.
export const PAYIN_METHODS = [
  'ach',
  'wire',
  'pix',
  'ted',
  'spei',
  'transfers',
  'pse',
  'international_swift',
  'rtp',
] as const;
export type PayinMethod = (typeof PAYIN_METHODS)[number];

// Whether a quote's request_amount is denominated in what the sender sends or
// what the receiver receives.
export const CURRENCY_TYPES = ['sender', 'receiver'] as const;
export type CurrencyType = (typeof CURRENCY_TYPES)[number];

// KYC/KYB entity kind.
export const RECEIVER_TYPES = ['individual', 'business'] as const;
export type ReceiverType = (typeof RECEIVER_TYPES)[number];

// Depth of compliance verification.
export const KYC_TYPES = ['light', 'standard', 'enhanced'] as const;
export type KycType = (typeof KYC_TYPES)[number];

// The on-chain family a payout/payin executes on — selects the BlindPay
// `/payouts/{chain}` and `/payins/{chain}` sub-route.
export const CHAIN_VARIANTS = ['evm', 'stellar', 'solana'] as const;
export type ChainVariant = (typeof CHAIN_VARIANTS)[number];

// Storage buckets accepted by the document upload endpoint.
export const UPLOAD_BUCKETS = [
  'avatar',
  'onboarding',
  'limit_increase',
] as const;
export type UploadBucket = (typeof UPLOAD_BUCKETS)[number];

// Account ownership classification used by US/EUR bank account rails.
export const ACCOUNT_CLASSES = ['individual', 'business'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

// Checking vs savings, for rails that distinguish them.
export const BANK_ACCOUNT_TYPES = ['checking', 'saving'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** BlindPay id prefixes, for sanity checks / documentation. */
export const ID_PREFIX = {
  receiver: 're_',
  wallet: 'bw_',
  bankAccount: 'ba_',
  virtualAccount: 'va_',
  payin: 'pi_',
  payout: 'pa_',
  quote: 'qe_',
} as const;

/**
 * How long a mirrored BlindPay row may be served from our own database before a
 * single-resource read refreshes it upstream.
 *
 * Webhooks are the primary path for status changes, so the refresh is a safety
 * net for a missed delivery rather than the source of truth. Refreshing on
 * *every* GET pinned our p99 to BlindPay's (15s timeout, no retry) and turned
 * each read into a write; a short window keeps reads local while bounding how
 * stale an un-webhooked row can get.
 */
export const MIRROR_FRESHNESS_MS = 60_000;

/** How far a Svix webhook timestamp may drift before the delivery is rejected. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

/** Prefix on the Svix endpoint secret; the rest is the base64 HMAC key. */
export const SVIX_SECRET_PREFIX = 'whsec_';

/**
 * The shortest HMAC key a Svix endpoint secret may decode to. Svix mints 24
 * random bytes (`whsec_` + 32 base64 characters), so anything shorter is a
 * truncated or mistyped value — and at the extreme an EMPTY key, which is what
 * `Buffer.from(…, 'base64')` silently makes of a string outside the alphabet.
 * A webhook signed with an empty key is one anybody can sign.
 */
export const SVIX_MIN_SECRET_BYTES = 24;

/**
 * Every BlindPay platform instance this service talks to, production first — the
 * order the inbound webhook tries their secrets in.
 */
export const BLINDPAY_ENVIRONMENTS: readonly BlindpayEnvironment[] = [
  'prod',
  'dev',
];

/**
 * The variables that set each instance up, named in the 503 a caller gets when
 * its environment's instance is not configured, so the operator reading it knows
 * which pair is missing rather than only that "BlindPay" is.
 */
export const BLINDPAY_INSTANCE_ENV_VARS: Readonly<
  Record<BlindpayEnvironment, string>
> = {
  prod: 'BLINDPAY_API_KEY and BLINDPAY_INSTANCE_ID',
  dev: 'BLINDPAY_API_KEY_DEV and BLINDPAY_INSTANCE_ID_DEV',
};

/**
 * Payin/payout statuses that mean the money stopped moving. A webhook may move a
 * row *into* one of these at any time (`completed` -> `refunded` is a real
 * transition), but never back out.
 */
export const SETTLED_STATUSES = [
  'completed',
  'failed',
  'refunded',
  'cancelled',
] as const;

/** Terminal BlindPay KYC statuses; mirrors `kyc/receivers/receiver-state.ts`. */
export const SETTLED_KYC_STATUSES = ['approved', 'rejected'] as const;

/**
 * Every BlindPay-backed request one consumer may cause in a minute, across KYC,
 * onramp and offramp.
 *
 * One BlindPay instance serves every tenant on a key (two, counting the dev
 * instance), so the provider's quota is a shared resource:
 * a tenant looping quotes does not merely slow itself down, it fails other
 * tenants' payins. The per-address budgets on each route tell one ordinary
 * caller from another and do nothing about that, because a tenant chooses how
 * many addresses it calls from — this ceiling is what it cannot multiply.
 *
 * Sixty a minute is far above an integrator's honest use: a quote, a payin and a
 * document upload are each one call, and a human-driven KYC flow is a handful
 * per person. A batch importer legitimately above it should hold its own key.
 *
 * Stacked *alongside* each route's per-address budget, never instead of it: the
 * two answer different questions, and the guard counts both.
 */
export const BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT = {
  name: 'blindpay:quota',
  limit: 60,
  windowMs: 60 * 1000,
  per: 'consumer' as const,
};

/**
 * Below this, a quote's `expires_at` is read as Unix SECONDS; at or above it, as
 * milliseconds. BlindPay documents neither, and 10^10 seconds is the year 2286
 * while 10^10 milliseconds is April 1970, so no real expiry sits on the wrong side.
 */
export const EPOCH_SECONDS_CEILING = 10_000_000_000;

/** The status a payin/payout reaches when BlindPay reports it settled for good. */
export const BLINDPAY_COMPLETED_STATUS = 'completed';

/**
 * The status of a payin/payout row opened BEFORE the provider call, until the
 * provider answers with the resource it created.
 *
 * Writing the row first is what keeps a payin or payout BlindPay created from
 * existing nowhere here: when the POST timed out, or the write after it failed,
 * the row is still there, carrying the quote and its execution key, and the
 * webhook (by `quote_id`) or a retried create (by the same Idempotency-Key)
 * fills in the provider id. Tenant reads leave such rows out — there is nothing
 * at the provider to show for them yet.
 */
export const BLINDPAY_PENDING_PROVIDER_STATUS = 'pending_provider';

/**
 * What the reconciler moves a {@link BLINDPAY_PENDING_PROVIDER_STATUS} row to
 * once {@link BLINDPAY_UNCONFIRMED_AFTER_MS} has passed with no provider id.
 *
 * It does not say the resource does not exist: the provider call was ambiguous
 * (a timeout, a 5xx) and nothing has attributed it since. It stops the row from
 * being reported again and makes it findable for an operator; a late webhook or
 * a retried create still attaches it, since the status is not settled.
 */
export const BLINDPAY_UNCONFIRMED_STATUS = 'provider_unconfirmed';

/**
 * Upstream statuses after which a failed payin/payout POST may still have
 * created the resource: a timeout, and a conflict (which an Idempotency-Key
 * replay of a request still in flight answers with). Any other 4xx is a refusal
 * — nothing was created, and the row opened for it is discarded. 5xx and
 * transport failures are ambiguous by default.
 */
export const BLINDPAY_AMBIGUOUS_CLIENT_STATUSES: readonly number[] = [408, 409];

/**
 * How often the reconciler runs. It is a safety net under the webhook, not the
 * primary path, so once a minute is plenty — and it shares the instance's
 * request quota with every tenant (see BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT).
 */
export const BLINDPAY_RECONCILE_INTERVAL_MS = 60_000;

/**
 * Provider reads per kind (payins, payouts, open webhook events) per instance in
 * one reconciler tick. Bounded so one tick costs at most
 * 3 × {@link BLINDPAY_RECONCILE_BATCH} requests per instance however far behind
 * the mirror is: a backlog drains over several ticks instead of in one burst
 * against a quota other tenants are using.
 */
export const BLINDPAY_RECONCILE_BATCH = 10;

/**
 * The reconciler's lock spans its provider reads, so its transaction must
 * outlive every one of them timing out: one read per row of each batch for two
 * instances, plus the database work around them.
 */
export const BLINDPAY_RECONCILE_LOCK_TIMEOUT_MULTIPLIER =
  BLINDPAY_RECONCILE_BATCH * 3 * 2 + 1;

/**
 * How long a {@link BLINDPAY_PENDING_PROVIDER_STATUS} row may wait for a provider
 * id before it is marked {@link BLINDPAY_UNCONFIRMED_STATUS}. A quote lives about
 * five minutes, and Svix's first retries land within the hour, so a row still
 * unattributed after that is one an operator should look at.
 */
export const BLINDPAY_UNCONFIRMED_AFTER_MS = 60 * 60 * 1000;

/**
 * How old an open webhook event must be before the reconciler retries it.
 * Younger ones may still be in the hands of the request that recorded them, or
 * of Svix's own retry.
 */
export const BLINDPAY_OPEN_EVENT_MIN_AGE_MS = 60_000;

/**
 * How long the reconciler keeps trying to attribute an open webhook event. Past
 * this it stops. Every failed attempt before that logged the `svix-id`, so the
 * delivery can be replayed from the Svix dashboard once whatever kept it
 * unattributed is fixed — and the row stays, still open, for an operator.
 */
export const BLINDPAY_OPEN_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
