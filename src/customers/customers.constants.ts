/**
 * Wallets one customer may hold. Enough for a person's or a company's addresses on every chain
 * payments settle on, and a bound on the nested list one create or one customer can write.
 */
export const MAX_CUSTOMER_WALLETS = 20;

/** A wallet's label, as the dashboard shows it beside the address ("Treasury", "Phantom"). */
export const CUSTOMER_WALLET_LABEL_MAX = 60;

/** The `reference` of a customer added from a settled payment's payer, not by the merchant. */
export const AUTO_CUSTOMER_REFERENCE = 'auto';
