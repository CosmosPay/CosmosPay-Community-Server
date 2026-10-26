/**
 * The merchant fee: what an organization charges ITS OWN customers on an
 * operation it runs through this API (a platform reselling payments or swaps to
 * other businesses), paid on-chain to a wallet it names. It is separate from,
 * and never replaces, the plan commission Cosmos Pay charges the organization.
 */

/**
 * The most the percentage part may be: 10% (1,000 basis points). A merchant
 * prices its own service, but past this a value is far more likely a unit
 * mistake (a whole percent written where basis points go) than a price, and
 * it is refused before anyone is asked to sign.
 */
export const MAX_MERCHANT_FEE_BPS = 1_000;

/**
 * Who pays the merchant fee, chosen per request:
 *
 * - `recipient`: deducted from `amount`. The payer sends `amount`; the merchant
 *   fee comes out of it (the receiver gets less, a swap routes less).
 * - `payer`: added on top. The payer sends `amount` plus the fee; the receiver
 *   gets `amount` (a swap routes `amount`).
 */
export const MERCHANT_FEE_PAYERS = ['recipient', 'payer'] as const;
export type MerchantFeePayer = (typeof MERCHANT_FEE_PAYERS)[number];

/** A request that names no payer: the fee comes out of the amount. */
export const DEFAULT_MERCHANT_FEE_PAYER: MerchantFeePayer = 'recipient';

/** The longest wallet a request may name (a NEAR account id is 64; EVM 42). */
export const MERCHANT_FEE_WALLET_MAX_LENGTH = 128;
