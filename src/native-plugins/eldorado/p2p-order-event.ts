import {
  P2P_ORDER_CANCELLED,
  P2P_ORDER_COMPLETED,
  P2P_ORDER_TYPE_BUY,
  P2P_WEBHOOK_EVENT,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * The marketplace's order webhook (`ORDER_STATUS_CHANGED`), read defensively:
 * pure functions over the parsed body, no Nest and no I/O. Only the fields this
 * service acts on are read, each checked for its shape; anything else is
 * ignored. The envelope is undocumented, so the order is taken from
 * `body.order`, `body.data.order`, `body.data` or the body itself, whichever
 * first carries an `orderStatus`.
 */

/** One order as the webhook reports it, its fields read and checked. */
export interface P2pOrderEvent {
  /** The marketplace's order id (`apiOrderId`). */
  orderId: string | null;
  /** The raw `orderStatus`: REQUESTED, ACCEPTED, FIAT_PAID, ..., COMPLETED, CANCELLED. */
  status: string;
  /** `BUY` or `SELL`, or null when absent. */
  type: string | null;
  /**
   * `externalReferenceId`: a widget session's `reference` (`cp-<uuid>`), or
   * the payment request's id for a direct order.
   */
  reference: string | null;
  /** `cryptoDetails`: where the token went, on which chain, which token. */
  recipientAddress: string | null;
  chainId: number | null;
  tokenAddress: string | null;
  /** `quote.in.amount`: the local money the buyer paid, a decimal string. */
  fiatAmount: string | null;
  /** `quote.in.currency`: the local currency it was paid in, upper case. */
  fiatCurrency: string | null;
  /** `transferInfo.amountOut`: the token delivered, a decimal string (COMPLETED only). */
  amountOut: string | null;
  /** `transferInfo.txHashDestination`, else `transferInfo.txHash`. */
  txHash: string | null;
}

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A bounded, plain string (ids and statuses), or null. */
function word(value: unknown, max = 128): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && /^[A-Za-z0-9_.:-]+$/.test(text)
    ? text
    : null;
}

/** A non-negative decimal (string or number), or null. */
function decimal(value: unknown): string | null {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  return /^\d{1,30}(\.\d{1,36})?$/.test(text) ? text : null;
}

function evmAddress(value: unknown): string | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
    ? value
    : null;
}

function txHashOf(value: unknown): string | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)
    ? value
    : null;
}

function chainIdOf(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,15}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** The event name the body declares, when it declares one apart from the order. */
function declaredEvent(body: Json): string | null {
  for (const key of ['event', 'eventType', 'eventName']) {
    const name = word(body[key]);
    if (name) return name;
  }
  return null;
}

/**
 * The order a webhook body reports, or null when it reports none this service
 * can read (no `orderStatus`), or declares an event other than
 * `ORDER_STATUS_CHANGED`.
 */
export function readOrderEvent(body: unknown): P2pOrderEvent | null {
  const root = objectAt(body);
  if (!root) return null;
  const event = declaredEvent(root);
  if (event && event !== P2P_WEBHOOK_EVENT) return null;
  const data = objectAt(root.data);
  const order = [objectAt(root.order), objectAt(data?.order), data, root].find(
    (candidate) => candidate && word(candidate.orderStatus, 64),
  );
  if (!order) return null;
  const crypto = objectAt(order.cryptoDetails);
  const quoteIn = objectAt(objectAt(order.quote)?.in);
  const transfer = objectAt(order.transferInfo);
  return {
    orderId: word(order.apiOrderId) ?? word(order.orderId) ?? word(order.id),
    status: word(order.orderStatus, 64)!,
    type: word(order.type, 16),
    reference: word(order.externalReferenceId),
    recipientAddress: evmAddress(crypto?.recipientAddress),
    chainId: chainIdOf(crypto?.chainId),
    tokenAddress: evmAddress(crypto?.tokenAddress),
    fiatAmount: decimal(quoteIn?.amount),
    fiatCurrency: word(quoteIn?.currency, 16)?.toUpperCase() ?? null,
    amountOut: decimal(transfer?.amountOut),
    txHash: txHashOf(transfer?.txHashDestination) ?? txHashOf(transfer?.txHash),
  };
}

/** Whether the order reports the token delivered. */
export function isCompleted(order: P2pOrderEvent): boolean {
  return order.status === P2P_ORDER_COMPLETED;
}

/** Whether the order reports it was cancelled (by the payer, the seller or a timeout). */
export function isCancelled(order: P2pOrderEvent): boolean {
  return order.status === P2P_ORDER_CANCELLED;
}

/** A session as the webhook compares an order with it. */
export interface SessionTerms {
  side: string;
  address: string;
  chainId: number;
  tokenAddress: string;
  currency: string;
  amount: string;
}

/** Local money to the cent, so `15000` and `15000.00` are the same amount. */
function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/**
 * Why a COMPLETED `order` does not pay the payment request its session was
 * opened from, or null when it does: a purchase (`BUY`), delivered to the
 * session's recipient, on its chain, in its token (addresses in any case), paid
 * in the session's currency (any case) and for at least its amount. The widget
 * lets a buyer change the currency and the amount it was opened with, so a
 * completed order in another currency (15000 COP against 15000 ARS) or for less
 * is a payment the seller did not ask for, and an order with no readable
 * currency or amount proves none.
 */
export function completionProblem(
  order: P2pOrderEvent,
  session: SessionTerms,
): string | null {
  if (!isCompleted(order)) return `the order is ${order.status}`;
  if (session.side !== 'buy' || order.type !== P2P_ORDER_TYPE_BUY) {
    return `the order is ${order.type ?? 'of no type'}, not a purchase`;
  }
  if (
    !order.recipientAddress ||
    order.recipientAddress.toLowerCase() !== session.address.toLowerCase()
  ) {
    return 'the order delivered to another recipient';
  }
  if (order.chainId !== session.chainId) {
    return `the order delivered on chain ${order.chainId ?? 'unknown'}, not ${session.chainId}`;
  }
  if (
    !order.tokenAddress ||
    order.tokenAddress.toLowerCase() !== session.tokenAddress.toLowerCase()
  ) {
    return 'the order delivered another token';
  }
  if (!order.fiatCurrency) return 'the order carries no currency';
  if (order.fiatCurrency !== session.currency.toUpperCase()) {
    return `the order paid in ${order.fiatCurrency}, not ${session.currency}`;
  }
  if (!order.fiatAmount) return 'the order carries no amount paid';
  if (cents(order.fiatAmount) < cents(session.amount)) {
    return `the order paid ${order.fiatAmount}, less than ${session.amount}`;
  }
  return null;
}
