/** Constants for the Stellar path-payment swap flow. */

/**
 * On-chain MEMO_TEXT stamped on a swap that collects the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (the canonical label). ≤ 28
 * bytes (the MEMO_TEXT limit).
 */
export const SWAP_COMMISSION_MEMO = 'Cosmos Swap Commission';

/**
 * Budget for `POST /v1/swaps/:id/submit`, per consumer + client address.
 *
 * What is defended: every call that gets past validation can make this service
 * broadcast to Horizon — against the per-address budget all of its Horizon
 * traffic shares — and every rejection writes a `SWAP_FAILED` event with its
 * delivery rows. The route takes the shared public API key, under which every
 * anonymous wallet is the same consumer, so the address is what separates them.
 * `SETTLEMENT_MAX_RESUBMITS` and the relay's expiry check bound what one swap can
 * cost; this bounds what one address can cost across many swaps.
 *
 * Why twenty. An honest wallet submits once per swap, retries a few times when
 * Horizon is unreachable (the 503 leaves the swap SUBMITTED and asks for exactly
 * that retry), and resubmits at most `SETTLEMENT_MAX_RESUBMITS` times after a
 * real rejection. Twenty is several of those flows at once from one address — a
 * household, a carrier NAT — while holding a loop to twenty broadcasts a minute
 * (forty across a fixed-window boundary).
 *
 * Why a one-minute window, when Pollar's are ten: the envelope being retried only
 * lives `STELLAR_TX_TIMEOUT` (300 s by default). A wallet refused early in a
 * ten-minute window would watch its envelope expire before `Retry-After` came
 * round; a minute keeps the retry inside the envelope's life.
 */
export const SWAP_SUBMIT_RATE_LIMIT = {
  name: 'swaps:submit',
  limit: 20,
  windowMs: 60 * 1000,
};
