/** Tunables for the fiat-to-stablecoin onramp. */

// Every route below reaches BlindPay, so each also carries
// `BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT`: these budgets separate one caller's
// address from another's, that ceiling separates one tenant from another.

/**
 * Budget for `POST /v1/onramp/quotes`, per consumer + client address.
 *
 * A quote is a BlindPay call and a row this service keeps, and the provider
 * counts it against the instance every tenant shares. Nothing is spent that an
 * error refunds. Thirty a minute is a person re-pricing an amount as they type,
 * a few times over, from several tabs; a pricing loop stops there.
 */
export const ONRAMP_QUOTE_RATE_LIMIT = {
  name: 'onramp:quote',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/onramp/payins`, per consumer + client address.
 *
 * A payin is money: it creates a BlindPay payin with its bank instructions and a
 * row here, and a later error does not withdraw it. Ten a minute is well past
 * one person paying, and several people behind one office address at once, while
 * a loop cannot fill the provider — or the operator's reconciliation — with
 * abandoned payins.
 */
export const ONRAMP_PAYIN_RATE_LIMIT = {
  name: 'onramp:payin',
  limit: 10,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/onramp/trustline`, per consumer + client address.
 *
 * The route builds an unsigned trustline envelope, which costs a Horizon account
 * read against the per-IP budget all of this service's Horizon traffic shares —
 * the one resource a customer-facing loop here can exhaust for everyone else.
 * Twenty a minute is a wallet retrying a build while the customer signs.
 */
export const ONRAMP_TRUSTLINE_RATE_LIMIT = {
  name: 'onramp:trustline',
  limit: 20,
  windowMs: 60 * 1000,
};
