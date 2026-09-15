/** Constants for the AMM liquidity-pool deposit/withdraw flow. */

/**
 * On-chain MEMO_TEXT stamped on operations that collect the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (it is the canonical label).
 * Kept ≤ 28 bytes (the MEMO_TEXT limit).
 */
export const LIQUIDITY_COMMISSION_MEMO = 'Cosmos Liquidity Commission';

/**
 * Page size when `GET /v1/liquidity-pools/positions` lists an account's pools —
 * Horizon's maximum, so any realistic account's positions are one round-trip.
 */
export const POSITIONS_POOL_PAGE_SIZE = 200;

/**
 * Hard stop on the pages that listing walks.
 *
 * The endpoint used to fetch each pool an account held shares in with its own
 * Horizon request, all at once in an unbounded `Promise.all`, and it is
 * reachable with the shared public API key: an account seeded with a few
 * hundred pool-share trustlines turned every call into a few hundred
 * simultaneous requests against the per-IP Horizon rate limit everyone shares.
 * Listing pools by account costs one request per 200. Stellar caps an account at
 * 1,000 subentries and every pool-share trustline is at least one of them, so
 * five pages hold any account the network allows; the stop exists so a cursor
 * that never runs dry cannot turn one call into an unbounded loop.
 */
export const POSITIONS_MAX_POOL_PAGES = 5;
