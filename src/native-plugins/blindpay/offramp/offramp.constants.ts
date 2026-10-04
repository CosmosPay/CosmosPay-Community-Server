/** Tunables for the stablecoin-to-fiat offramp. */

// Every route below reaches BlindPay, so each also carries
// `BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT`: these budgets separate one caller's
// address from another's, that ceiling separates one tenant from another.

/**
 * Budget for `POST /v1/offramp/quotes`, per consumer + client address.
 *
 * The onramp's twin, for the same reason and with the same number: a quote is a
 * provider call on a shared instance plus a stored row, and nothing an error
 * gives back. A bucket of its own so a customer pricing a payout does not spend
 * the budget of one funding an account.
 */
export const OFFRAMP_QUOTE_RATE_LIMIT = {
  name: 'offramp:quote',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/offramp/payouts/authorize` and `POST
 * /v1/offramp/payouts`, per consumer + client address.
 *
 * One bucket for both halves of one flow: authorize prepares the on-chain
 * approval the customer signs, the payout spends it. Counting them apart would
 * let a loop alternate and take both budgets, and they are never called at
 * different rates in an honest flow.
 *
 * Ten a minute for the same reason as the onramp's payin: this end of the flow
 * is money leaving, and an error afterwards does not bring it back.
 */
export const OFFRAMP_PAYOUT_RATE_LIMIT = {
  name: 'offramp:payout',
  limit: 10,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/offramp/payouts/:id/documents`, per consumer + client
 * address.
 *
 * Attaching a document is a BlindPay write that keeps what it is given, so the
 * same shape as `KYC_UPLOAD_RATE_LIMIT` and the same numbers: a payout needs an
 * invoice, sometimes a correction, and twenty in ten minutes covers several
 * payouts being documented at once.
 */
export const OFFRAMP_DOCUMENT_RATE_LIMIT = {
  name: 'offramp:document',
  limit: 20,
  windowMs: 10 * 60 * 1000,
};
