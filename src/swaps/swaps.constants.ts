/** Constants for the Stellar path-payment swap flow. */

/**
 * On-chain MEMO_TEXT stamped on a swap that collects the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (the canonical label). ≤ 28
 * bytes (the MEMO_TEXT limit).
 */
export const SWAP_COMMISSION_MEMO = 'Cosmos Swap Commission';
