/**
 * Tuning knobs and protocol facts for ZK payments: confidential transfers on
 * the OpenZeppelin Confidential Token (`stellar-confidential` 0.8.0) that
 * Cosmos Pay operates, with the amount hidden on-chain.
 */

/**
 * Cosmos Pay's commission on every ZK payment, in basis points: 1 bps, 0.01%.
 *
 * A constant, not an environment variable: it is the price of the product, the
 * same on every deployment, and a commission an operator could set to 0 by
 * forgetting a variable is a free product by accident. The payer pays the
 * gross amount; the merchant receives it minus this fee, and the fee goes to
 * the network's fee account as a second confidential transfer
 * (`zk-payment-fee.ts` has the rounding).
 */
export const ZK_PAYMENT_FEE_BPS = 1;

/**
 * The smallest fee, in stroops. A fee of 1 bps rounds to zero below 10,000
 * stroops (0.001 XLM), and a confidential transfer of zero would still cost the
 * payer a proof and a transaction while paying nothing. One stroop keeps every
 * payment paying something, and keeps the fee transfer a real transfer.
 */
export const ZK_PAYMENT_MIN_FEE_STROOPS = 1n;

/** The divisor of a basis-point rate. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * The auditor id every account on Cosmos Pay's token is registered under, and
 * the one Cosmos Pay holds the key of. The auditor registry Cosmos Pay deploys
 * registers exactly this one key, so an account cannot register under another.
 */
export const ZK_PAYMENT_AUDITOR_ID = 0;

/** What the token wraps, as the dashboard shows it: native XLM, 7 decimals. */
export const ZK_PAYMENT_TOKEN_SYMBOL = 'XLM';
export const ZK_PAYMENT_TOKEN_DECIMALS = 7;

/** The token entry point a payer pays with, and the event it emits. */
export const CONFIDENTIAL_TRANSFER_FUNCTION = 'confidential_transfer';
export const CONFIDENTIAL_TRANSFER_EVENT = 'transfer';

/** How long a new payment stays payable when the request names no lifetime. */
export const ZK_PAYMENT_DEFAULT_EXPIRES_IN_MINUTES = 60;

/**
 * The longest lifetime a request may ask for: seven days.
 *
 * The bound is the RPC, not taste. `confirm` reads both transactions back
 * through the Soroban RPC, which keeps transactions for a limited window, so a
 * payment that stays payable for weeks invites a payer to pay early and confirm
 * after the RPC has forgotten the transaction.
 */
export const ZK_PAYMENT_MAX_EXPIRES_IN_MINUTES = 7 * 24 * 60;

/**
 * How long before a payment's `createdAt` a transfer may have closed and still
 * count as that payment's.
 *
 * A payer builds both transfers after the payment exists, so an honest ledger
 * closes after `createdAt`. Without a floor, an older transfer of the same net
 * amount to the same merchant (made for something else) together with any
 * unused fee transfer of the right size could settle a new payment. The minute
 * of slack is only for clock disagreement between this host and the
 * validators, the same allowance payment intents use (`TX_CREATED_AT_SKEW_MS`).
 */
export const ZK_TX_CREATED_AT_SKEW_MS = 60_000;

/**
 * A Stellar transaction hash: 32 bytes, hex. Stored lowercase, the spelling the
 * RPC reports, so one transaction is one value in the unique indexes.
 */
export const ZK_TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** The longest `idempotencyKey` a create accepts. */
export const ZK_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** The longest `description` a create accepts. */
export const ZK_PAYMENT_DESCRIPTION_MAX_LENGTH = 280;

/** The prefix of an idempotency key this service mints when a request has none. */
export const ZK_PAYMENT_GENERATED_KEY_PREFIX = 'zkp_';

/**
 * Budget for `POST /v1/zk-payments`, per consumer + client address.
 *
 * A create reads the recipient's account from the Soroban RPC (is it
 * registered on the token?) and writes a row. Thirty a minute is a checkout
 * that retries, comfortably, and keeps a loop from spending the RPC budget
 * every other tenant shares.
 */
export const ZK_PAYMENT_CREATE_RATE_LIMIT = {
  name: 'zk-payments:create',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * Budget for `GET /v1/zk-payments/{id}/public`, the checkout's anonymous read,
 * per client address.
 *
 * `@Public()`, so there is no consumer to key on and the address is the whole
 * budget: it must stay `per: 'address'`. Sixty a minute is the payment links'
 * figure (`PAYMENT_LINK_READ_RATE_LIMIT`) for the same reason: a page polling
 * every 5 s spends 12, and a few payers behind one NAT still fit.
 */
export const ZK_PAYMENT_PUBLIC_READ_RATE_LIMIT = {
  name: 'zk-payments:public-read',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/zk-payments/{id}/confirm`, per client address.
 *
 * Also `@Public()`: the payer's checkout confirms, and the payer holds no API
 * key. Each call is two `getTransaction` reads against the Soroban RPC plus the
 * decryption, so it is the costliest anonymous route here. Twenty a minute is a
 * checkout retrying while the RPC catches up with the ledger, several times
 * over.
 */
export const ZK_PAYMENT_CONFIRM_RATE_LIMIT = {
  name: 'zk-payments:confirm',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * How long one Soroban RPC call may take before it is a failure. The SDK's
 * `rpc.Server` has no default timeout, and a confirm that hangs holds the
 * payer's checkout open with it.
 */
export const ZK_RPC_TIMEOUT_MS = 15_000;
