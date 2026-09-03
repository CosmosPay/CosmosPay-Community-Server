import type { SwapStatus } from '@generated/prisma/client';

/**
 * Swap state machine (issue #29).
 *
 * Submit and the settlement observer both write the same row. Terminal webhook
 * events must fire only for the writer that won the status transition — a late
 * FAILED must not overwrite SUCCEEDED, and the two paths must not each mint
 * their own `evt_` id for the same (swap, event type).
 *
 * Only the guard sets that `swaps.service.ts` actually passes to `updateMany`
 * live here. A constant that nothing reads drifts silently from the behaviour it
 * claims to describe — which is exactly what happened to a former
 * `SWAP_CAN_SUBMIT_STATUSES` — so a set earns its place here only once it is the
 * single source of the check.
 */

/**
 * Statuses that may still be finalized as FAILED or EXPIRED. SUCCEEDED is
 * intentionally absent — a settled swap cannot be degraded.
 */
export const SWAP_IN_FLIGHT_STATUSES = [
  'PENDING',
  'SUBMITTED',
] as const satisfies readonly SwapStatus[];

/**
 * Statuses that may still be promoted to SUCCEEDED. FAILED and EXPIRED are
 * included so a Horizon rejection / false expiry cannot beat on-chain inclusion
 * (observer/submit success heals a false terminal).
 */
export const SWAP_CAN_SUCCEED_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'FAILED',
  'EXPIRED',
] as const satisfies readonly SwapStatus[];

/**
 * Statuses that may still be marked FAILED. EXPIRED is included so the
 * settlement observer's 24h rescue sweep can correct a false expiry when
 * Horizon later reports an unsuccessful tx.
 */
export const SWAP_CAN_FAIL_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'EXPIRED',
] as const satisfies readonly SwapStatus[];
