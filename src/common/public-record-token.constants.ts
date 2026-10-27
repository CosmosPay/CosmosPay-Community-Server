/**
 * Constants for the per-record read tokens of records the shared public key
 * creates (`PublicRecordTokens`).
 */

/**
 * The header a caller on the shared public key sends a record's token in, on
 * the reads and actions of one record (`GET /v1/swaps/{id}`, its submit, ...).
 * Lower-case, as Node delivers header names.
 */
export const RECORD_TOKEN_HEADER = 'x-record-token';

/**
 * HKDF's `info`: what the derived key is for. A versioned label, so a future
 * change of scheme is a new label (and new tokens) rather than a key that means
 * two things. Changing it invalidates every token handed out.
 */
export const RECORD_TOKEN_KEY_LABEL = 'public-record-token v1';

/**
 * HKDF's salt. Fixed and public: the separation between the keys this service
 * derives from one secret is the label, and the salt only keeps this family
 * apart from the JWT and sealed-box ones (`cosmos-jwt`, ...).
 */
export const RECORD_TOKEN_KEY_SALT = 'cosmos-public-record-token';

/**
 * One kind per table whose rows the shared public key creates and may read
 * back. The token MACs `<kind>:<id>`, so a Stellar swap's token never opens a
 * chain swap, a cross-chain swap or a USDT0 transfer with the same id.
 */
export const PUBLIC_RECORD_KINDS = [
  'swap',
  'chain-swap',
  'cross-chain-swap',
  'usdt0-transfer',
] as const;
export type PublicRecordKind = (typeof PUBLIC_RECORD_KINDS)[number];

/**
 * The routes the wallet called with the shared public key BEFORE record tokens
 * existed. With that key they still accept a request with no `X-Record-Token`,
 * logged as deprecated, so an older wallet keeps working, until
 * `PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY` turns the token on there too. A wrong
 * token is refused on them either way. Every other route that takes a record
 * token requires it.
 */
export const LEGACY_RECORD_TOKEN_ROUTES = {
  swapSubmit: 'POST /v1/swaps/{id}/submit',
  crossChainDeposit: 'POST /v1/cross-chain-swaps/{id}/deposit',
} as const;
export type LegacyRecordTokenRoute =
  (typeof LEGACY_RECORD_TOKEN_ROUTES)[keyof typeof LEGACY_RECORD_TOKEN_ROUTES];
