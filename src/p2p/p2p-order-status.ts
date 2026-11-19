import type { P2pChainStatus } from '@/p2p/p2p-market-abi';

/**
 * How a P2P order reads through the API, and how indexed events move it.
 * Pure: the indexer applies {@link P2P_EVENT_TRANSITIONS} as compare-and-swap
 * writes (`status IN from` → `to`), and nothing but an indexed event moves an
 * order past `pending` except the two this service decides itself (`pending`
 * and `failed`).
 */

export const P2P_ORDER_STATUSES = [
  'pending',
  'awaiting_acceptance',
  'awaiting_payment',
  'paid',
  'disputed',
  'completed',
  'cancelled',
  'expired',
  'resolved',
  'failed',
] as const;
export type P2pOrderStatus = (typeof P2P_ORDER_STATUSES)[number];

export const P2P_ORDER_KINDS = ['BUY', 'SELL', 'CHARGE', 'PAYOUT'] as const;
export type P2pOrderKind = (typeof P2P_ORDER_KINDS)[number];

/** Orders whose tokens are still locked: they count against a merchant and show details. */
export const P2P_LIVE_STATUSES: readonly P2pOrderStatus[] = [
  'pending',
  'awaiting_acceptance',
  'awaiting_payment',
  'paid',
  'disputed',
];

/** Orders that end here. */
export const P2P_FINAL_STATUSES: readonly P2pOrderStatus[] = [
  'completed',
  'cancelled',
  'expired',
  'resolved',
  'failed',
];

/** The contract's status, as the API reads it (`Cancelled` may read `expired`). */
export const CHAIN_TO_API_STATUS: Record<
  P2pChainStatus,
  P2pOrderStatus | null
> = {
  None: null,
  Offered: 'awaiting_acceptance',
  Active: 'awaiting_payment',
  Paid: 'paid',
  Disputed: 'disputed',
  Released: 'completed',
  Cancelled: 'cancelled',
  Resolved: 'resolved',
};

/**
 * Which side of the contract the merchant is on, per kind. A purchase and a
 * charge lock the MERCHANT's tokens (it sells them); a sale and a payout lock
 * the person's or the client's tokens and the merchant buys them, with a bond.
 */
export const P2P_MERCHANT_SIDE: Record<P2pOrderKind, 'seller' | 'buyer'> = {
  BUY: 'seller',
  CHARGE: 'seller',
  SELL: 'buyer',
  PAYOUT: 'buyer',
};

/** The events that move an order, and from where. */
export const P2P_EVENT_TRANSITIONS = {
  // `OrderOpened` moves `pending` (and a late-signed sale's `failed`) to the
  // status the chain answers: `awaiting_acceptance` or `awaiting_payment`.
  OrderAccepted: { from: ['awaiting_acceptance'], to: 'awaiting_payment' },
  OrderPaid: { from: ['awaiting_payment'], to: 'paid' },
  OrderReleased: { from: ['awaiting_payment', 'paid'], to: 'completed' },
  OrderDisputed: { from: ['paid'], to: 'disputed' },
  OrderResolved: { from: ['disputed'], to: 'resolved' },
  // `OrderCancelled` reads `cancelled` or `expired`: see cancellationStatus.
  OrderCancelled: {
    from: ['awaiting_acceptance', 'awaiting_payment', 'paid'],
    to: 'cancelled',
  },
} as const satisfies Record<
  string,
  { from: readonly P2pOrderStatus[]; to: P2pOrderStatus }
>;

/** The statuses `OrderOpened` may move an order from. */
export function openableFrom(kind: P2pOrderKind): P2pOrderStatus[] {
  // A sale the person signed after we gave up on it still locked their
  // tokens: follow it, so it can be accepted or cancelled like any other.
  return kind === 'SELL' ? ['pending', 'failed'] : ['pending'];
}

/** What a cancelled order reads as. */
export interface CancellationFacts {
  /** The status the order had before the cancel. */
  previous: P2pOrderStatus;
  /** Unix seconds of the block that cancelled it. */
  at: number;
  /** Unix seconds; null when the order never had one. */
  acceptDeadline: number | null;
  paymentDeadline: number | null;
}

/**
 * `expired` when the order was cancelled after the deadline of the step it
 * was waiting on (accepting, or paying): it ran out of time; anyone may cancel
 * then, and the expiry job does. Before the deadline a cancel is somebody's
 * choice: `cancelled`. A paid order never expires.
 */
export function cancellationStatus(
  facts: CancellationFacts,
): 'cancelled' | 'expired' {
  const deadline =
    facts.previous === 'awaiting_acceptance'
      ? facts.acceptDeadline
      : facts.previous === 'awaiting_payment'
        ? facts.paymentDeadline
        : null;
  return deadline !== null && facts.at > deadline ? 'expired' : 'cancelled';
}

/**
 * Whether an order that ended without completing counts against its merchant
 * (`cancelled` in its stats): the merchant was the side that had to act and
 * did not. A purchase that expired unpaid is the person's; a sale or a payout
 * the merchant did not accept or pay in time is the merchant's.
 */
export function merchantAtFault(
  kind: P2pOrderKind,
  previous: P2pOrderStatus,
  outcome: 'cancelled' | 'expired',
  cancelledByMerchant: boolean,
): boolean {
  if (cancelledByMerchant) return true;
  if (outcome !== 'expired') return false;
  return (
    P2P_MERCHANT_SIDE[kind] === 'buyer' &&
    (previous === 'awaiting_acceptance' || previous === 'awaiting_payment')
  );
}

/**
 * Whether an arbiter's resolution went against the merchant: as the seller,
 * the buyer got paid (the merchant should have released); as the buyer, it
 * did not get the whole amount (it reported a payment it did not make).
 */
export function merchantLostDispute(
  kind: P2pOrderKind,
  amount: bigint,
  toBuyer: bigint,
): boolean {
  return P2P_MERCHANT_SIDE[kind] === 'seller' ? toBuyer > 0n : toBuyer < amount;
}

/** The median of a list of seconds, or null for none. */
export function medianSeconds(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
