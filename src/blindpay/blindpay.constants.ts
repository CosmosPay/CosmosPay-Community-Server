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
