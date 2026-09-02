/** Constants for the AMM liquidity-pool deposit/withdraw flow. */

/**
 * On-chain MEMO_TEXT stamped on operations that collect the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (it is the canonical label).
 * Kept ≤ 28 bytes (the MEMO_TEXT limit).
 */
export const LIQUIDITY_COMMISSION_MEMO = 'Cosmos Liquidity Commission';
