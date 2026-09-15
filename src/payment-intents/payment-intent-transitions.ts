/**
 * Executable spec for the PaymentIntent state machine (issue #36).
 *
 * This graph is the single source of truth for allowed transitions.
 * Anything not declared here is rejected. Status names match the Prisma
 * `PaymentIntentStatus` enum and must not be renamed.
 */
export const PAYMENT_INTENT_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type PaymentIntentStatusName = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * Terminal statuses cannot be abandoned: no status a caller asks for moves an
 * intent out of one, and the txHash it carries is frozen. EXPIRED keeps a single
 * exit, for a payment the chain confirms — see
 * {@link VERIFIED_SETTLEMENT_ONLY_FROM}.
 */
export const TERMINAL_STATUSES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const satisfies readonly PaymentIntentStatusName[];

export type TerminalPaymentIntentStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Declared transition graph: from each status, the set of allowed next statuses.
 * Deny-by-default — undeclared edges are invalid.
 *
 * EXPIRED → SUCCEEDED is the one edge out of a terminal status. Expiry is an
 * inference — nobody paid within the lifetime — and a payment the chain confirms
 * afterwards disproves it. With no edge back, an intent paid late in its
 * lifetime stayed EXPIRED for good and PAYMENT_INTENT_SUCCEEDED never went out.
 * Swaps and liquidity operations heal a false expiry the same way
 * (`SWAP_CAN_SUCCEED_STATUSES`, `LP_OPERATION_TRANSITIONS`). SUCCEEDED, FAILED
 * and CANCELLED stay absorbing.
 */
export const PAYMENT_INTENT_TRANSITIONS: Record<
  PaymentIntentStatusName,
  readonly PaymentIntentStatusName[]
> = {
  PENDING: ['SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUBMITTED: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: ['SUCCEEDED'],
};

/** Reaching SUCCEEDED always requires an on-chain transaction reference. */
export const SUCCESS_REQUIRES_TX_HASH = true as const;

/**
 * Terminal statuses that only a payment verified on-chain may move to SUCCEEDED.
 *
 * A txHash on its own is a formatting check, not a proof. For PENDING and
 * SUBMITTED the service is what verifies before settling (`settleFromApi`); for
 * a terminal status the state machine demands the proof itself, so a path that
 * forgot to verify is refused here instead of reopening a finalized intent on a
 * caller's word.
 */
export const VERIFIED_SETTLEMENT_ONLY_FROM = [
  'EXPIRED',
] as const satisfies readonly TerminalPaymentIntentStatus[];
