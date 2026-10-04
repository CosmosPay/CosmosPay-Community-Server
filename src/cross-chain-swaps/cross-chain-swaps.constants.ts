/** Constants for cross-chain swaps settled by NEAR Intents. */

/**
 * Budget for `POST /v1/cross-chain-swaps/quote`, per consumer + client address.
 *
 * A quote persists nothing here, but it is a solver auction at 1Click, and every
 * call this service makes counts against the one partner key the whole
 * deployment shares. The route takes the shared public key, so a wallet polling
 * a price in a loop would spend that budget for every anonymous caller at once.
 * Sixty a minute is a price refreshed once a second — as fast as anyone reads one.
 */
export const CROSS_CHAIN_QUOTE_RATE_LIMIT = {
  name: 'cross-chain-swaps:quote',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/cross-chain-swaps`, per consumer + client address.
 *
 * Each create is a live 1Click quote that derives a deposit address, a row this
 * service polls until the swap settles or the deadline plus
 * {@link CROSS_CHAIN_RESCUE_WINDOW_MS} passes, and a webhook. Twenty a minute is
 * several honest swaps started at once from one address; a builder that never
 * deposits is bounded the same way.
 */
export const CROSS_CHAIN_CREATE_RATE_LIMIT = {
  name: 'cross-chain-swaps:create',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/cross-chain-swaps/{id}/deposit`, per consumer + client
 * address. An honest wallet reports a deposit once, and retries a few times if
 * 1Click is slow to see it; each call is an upstream request and a possible
 * webhook.
 */
export const CROSS_CHAIN_DEPOSIT_RATE_LIMIT = {
  name: 'cross-chain-swaps:deposit',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Rows the observer asks 1Click about per tick. Each is one `GET /v0/status`,
 * made one after another under the advisory lock; fifty at the default
 * NEAR_INTENTS_TIMEOUT_MS stays well inside the lock's transaction budget even
 * when 1Click is slow, and the least recently checked rows go first, so a
 * backlog is worked through over a few ticks rather than starved.
 */
export const CROSS_CHAIN_OBSERVER_BATCH = 50;

/**
 * How long past its deadline an EXPIRED swap is still polled. 1Click refunds a
 * deposit that arrives late, and the row has to follow it to REFUNDED — a day
 * covers a wallet that broadcast just before the deadline on a congested chain,
 * and bounds how long an address nobody paid costs a status call per tick.
 */
export const CROSS_CHAIN_RESCUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The lock transaction's budget, as a multiple of the NEAR Intents timeout: one
 * tick is at most {@link CROSS_CHAIN_OBSERVER_BATCH} sequential status calls,
 * but 1Click answers in well under a second when healthy, so a tick that needs
 * more than this many timeouts' worth is one to abandon and retry.
 */
export const CROSS_CHAIN_LOCK_TIMEOUT_MULTIPLIER = 6;
