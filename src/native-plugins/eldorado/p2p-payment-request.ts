import { P2P_PAYMENT_REQUEST_PAGE_PATH } from '@/native-plugins/eldorado/eldorado.constants';
import type {
  P2pCurrency,
  P2pPaymentMethod,
  P2pToken,
} from '@/native-plugins/eldorado/p2p-market';
import { estimateAmountOut } from '@/native-plugins/eldorado/p2p-market';

/**
 * Payment requests (charges in local money shown as a QR): the pure rules over
 * a row, with no Nest and no I/O, so a spec calls them on plain objects.
 */

/** What a payment request reads as. `expired` is derived, never stored. */
export type P2pPaymentRequestStatus = 'open' | 'paid' | 'expired' | 'cancelled';

/** What the `status` column holds. */
export type StoredP2pPaymentRequestStatus = Exclude<
  P2pPaymentRequestStatus,
  'expired'
>;

/** Every status a request reads as, in the order the contract lists them. */
export const P2P_PAYMENT_REQUEST_STATUSES: readonly P2pPaymentRequestStatus[] =
  ['open', 'paid', 'expired', 'cancelled'];

/** The stored values, each read as itself (an open one may read as expired). */
const STORED_STATUSES: Readonly<
  Record<StoredP2pPaymentRequestStatus, P2pPaymentRequestStatus>
> = {
  open: 'open',
  paid: 'paid',
  cancelled: 'cancelled',
};

/**
 * What a request reads as at `now`: its stored status, except an open one past
 * `expiresAt`, which reads as expired (and is never written as such: the
 * webhook may still mark it paid, because the money arrived). A value the
 * column should never hold is a corrupt row: an error, not a guess.
 */
export function effectiveStatus(
  row: { id: string; status: string; expiresAt: Date },
  now: Date,
): P2pPaymentRequestStatus {
  const stored = (STORED_STATUSES as Record<string, P2pPaymentRequestStatus>)[
    row.status
  ];
  if (!stored) {
    throw new Error(
      `Payment request ${row.id} has unknown status "${row.status}"`,
    );
  }
  return stored === 'open' && row.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : stored;
}

/** The payer's page: `<payments origin>/fiat/<id>`. */
export function paymentRequestUrl(origin: string, id: string): string {
  return `${origin.replace(/\/+$/, '')}/${P2P_PAYMENT_REQUEST_PAGE_PATH}/${id}`;
}

/** The columns the payer's read loads: never the owner, the seller's address or the payment. */
export const P2P_PAYMENT_REQUEST_PAYER_SELECT = {
  id: true,
  network: true,
  status: true,
  currency: true,
  amount: true,
  description: true,
  chainId: true,
  token: true,
  tokenAddress: true,
  expiresAt: true,
  createdAt: true,
  paidAt: true,
} as const;

/** A request as {@link P2P_PAYMENT_REQUEST_PAYER_SELECT} loads it. */
export interface PayerRow {
  id: string;
  network: string;
  status: string;
  currency: string;
  amount: string;
  description: string | null;
  chainId: number;
  token: string;
  tokenAddress: string;
  expiresAt: Date;
  createdAt: Date;
  paidAt: Date | null;
}

/** The market's answer for a request's terms right now: null for what it does not offer (or when it cannot be read). */
export interface LiveBuyTerms {
  currency: P2pCurrency | null;
  token: P2pToken | null;
}

/** What the payer reads: the charge and how to pay it, never who is paid. */
export interface PublicP2pPaymentRequest {
  id: string;
  network: string;
  status: P2pPaymentRequestStatus;
  currency: string;
  amount: string;
  description: string | null;
  chainId: number;
  token: string;
  tokenAddress: string;
  estimatedAmountOut: string | null;
  paymentMethods: P2pPaymentMethod[];
  expiresAt: string;
  createdAt: string;
  paidAt: string | null;
}

/**
 * What a payer may see of a request, field by field. Written out rather than
 * spread: whatever row it is handed (a full one carries the consumer, the
 * seller's address and the payment), it answers exactly these fields. The
 * estimate and the payment methods come from the live market (`live`), so they
 * follow the price while the page is open; both are empty when it cannot be read.
 */
export function toPublicPaymentRequest(
  row: PayerRow,
  live: LiveBuyTerms,
  now: Date,
): PublicP2pPaymentRequest {
  return {
    id: row.id,
    network: row.network,
    status: effectiveStatus(row, now),
    currency: row.currency,
    amount: row.amount,
    description: row.description,
    chainId: row.chainId,
    token: row.token,
    tokenAddress: row.tokenAddress,
    estimatedAmountOut:
      live.currency && live.token
        ? estimateAmountOut(
            row.amount,
            live.currency.price,
            live.token.priceUsd,
            'buy',
          )
        : null,
    paymentMethods: live.currency
      ? live.currency.paymentMethods.map((m) => ({ id: m.id, name: m.name }))
      : [],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}
