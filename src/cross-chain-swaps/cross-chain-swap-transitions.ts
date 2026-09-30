import type {
  CrossChainSwapStatus,
  WebhookEventType,
} from '@generated/prisma/client';
import {
  NEAR_INTENTS_STATUSES,
  type NearIntentsStatus,
} from '@/near-intents/near-intents.constants';

/**
 * The cross-chain swap state machine. 1Click decides where a swap stands; this
 * file decides what that means for our row, and which transitions a stale or
 * out-of-order answer may not make.
 */

/** Statuses the observer still polls 1Click for. */
export const CROSS_CHAIN_OPEN_STATUSES = [
  'AWAITING_DEPOSIT',
  'DEPOSIT_DETECTED',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
] as const satisfies readonly CrossChainSwapStatus[];

/**
 * Absorbing: the money has moved for good — to the recipient, or back to the
 * payer. Nothing 1Click says later changes them. EXPIRED is not here: a
 * deposit that lands after the deadline is refunded by 1Click, and the row
 * must follow it to REFUNDED rather than claim nothing happened.
 */
export const CROSS_CHAIN_TERMINAL_STATUSES = [
  'SUCCEEDED',
  'REFUNDED',
  'FAILED',
] as const satisfies readonly CrossChainSwapStatus[];

/** What each of 1Click's statuses means for our row. */
export const PROVIDER_STATUS_MAP: Record<
  NearIntentsStatus,
  CrossChainSwapStatus
> = {
  PENDING_DEPOSIT: 'AWAITING_DEPOSIT',
  KNOWN_DEPOSIT_TX: 'DEPOSIT_DETECTED',
  INCOMPLETE_DEPOSIT: 'INCOMPLETE_DEPOSIT',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCEEDED',
  REFUNDED: 'REFUNDED',
  FAILED: 'FAILED',
};

/** The webhook each status arrives with. */
export const CROSS_CHAIN_STATUS_EVENTS: Record<
  CrossChainSwapStatus,
  WebhookEventType
> = {
  AWAITING_DEPOSIT: 'CROSS_CHAIN_SWAP_UPDATED',
  DEPOSIT_DETECTED: 'CROSS_CHAIN_SWAP_UPDATED',
  INCOMPLETE_DEPOSIT: 'CROSS_CHAIN_SWAP_UPDATED',
  PROCESSING: 'CROSS_CHAIN_SWAP_UPDATED',
  SUCCEEDED: 'CROSS_CHAIN_SWAP_SUCCEEDED',
  REFUNDED: 'CROSS_CHAIN_SWAP_REFUNDED',
  FAILED: 'CROSS_CHAIN_SWAP_FAILED',
  EXPIRED: 'CROSS_CHAIN_SWAP_EXPIRED',
};

export function isProviderStatus(value: unknown): value is NearIntentsStatus {
  return (
    typeof value === 'string' &&
    (NEAR_INTENTS_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminal(status: CrossChainSwapStatus): boolean {
  return (CROSS_CHAIN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The status a row moves to on 1Click's answer, or null when it stays put.
 *
 *   - A terminal row never moves.
 *   - "Still waiting for a deposit" past the deadline is EXPIRED — 1Click keeps
 *     answering PENDING_DEPOSIT for an address nobody paid, so the deadline is
 *     ours to apply. An EXPIRED row that is still waiting stays EXPIRED.
 *   - Anything else follows 1Click, including out of EXPIRED: a late deposit
 *     is refunded, and the row must say so.
 *   - A status word this service does not know is ignored, not guessed at.
 */
export function nextStatus(
  current: CrossChainSwapStatus,
  providerStatus: unknown,
  now: Date,
  expiresAt: Date,
): CrossChainSwapStatus | null {
  if (isTerminal(current) || !isProviderStatus(providerStatus)) return null;
  let next = PROVIDER_STATUS_MAP[providerStatus];
  if (next === 'AWAITING_DEPOSIT' && now.getTime() > expiresAt.getTime()) {
    next = 'EXPIRED';
  }
  return next === current ? null : next;
}
