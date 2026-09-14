import type { PaymentIntent } from '@generated/prisma/client';
import { toStroops } from '@/swaps/swap-math';

/**
 * Everything a create request fixes about the payment it describes: the columns
 * that end up inside the intent's SEP-7 `uri` (and so its QR), plus the kind and
 * network that decide how that URI is built and read.
 */
export type PaymentIntentTerms = Pick<
  PaymentIntent,
  | 'kind'
  | 'network'
  | 'source'
  | 'destination'
  | 'amount'
  | 'asset'
  | 'assetIssuer'
  | 'msg'
  | 'callback'
>;

/**
 * Whether a create request is a genuine retry of the intent already stored under
 * its `(consumer, memo)`.
 *
 * The memo is the idempotency key, and a create that hit it used to get the
 * stored intent back unconditionally. That is only safe while a key belongs to
 * one caller. Under the shared public API key every anonymous wallet user is the
 * same consumer, so a memo is a key anyone can claim first: `POST /pay` with the
 * attacker's destination and memo "42", and the next person to ask for memo "42"
 * was handed the attacker's `uri` and `qr` — a payment link to the wrong account
 * — together with a row that was never theirs to read.
 *
 * So a replay has to describe the same payment. Every term is compared, not only
 * the ones that move money: `msg` is what the payer's wallet displays and
 * `callback` is where a signed TX envelope gets posted, and both are inside the
 * `uri` the caller would receive.
 *
 * `source` is compared for TX intents only. A PAY intent is created without one
 * and has it filled in with the payer at settlement, so comparing it would turn
 * a retry of an already-paid link into a conflict with its own intent.
 *
 * Amounts are compared in stroops, so "2" and "2.0000000" are the same request.
 */
export function isSameIntentRequest(
  stored: PaymentIntentTerms,
  requested: PaymentIntentTerms,
): boolean {
  return (
    stored.kind === requested.kind &&
    stored.network === requested.network &&
    (requested.kind !== 'TX' || stored.source === requested.source) &&
    stored.destination === requested.destination &&
    sameAmount(stored.amount, requested.amount) &&
    stored.asset === requested.asset &&
    stored.assetIssuer === requested.assetIssuer &&
    stored.msg === requested.msg &&
    stored.callback === requested.callback
  );
}

function sameAmount(stored: string | null, requested: string | null): boolean {
  if (stored === null || requested === null) {
    return stored === requested;
  }
  try {
    return toStroops(stored) === toStroops(requested);
  } catch {
    // Not a representable Stellar amount on one side — the DTO pattern admits
    // more integer digits than int64 stroops hold. Such an intent can never be
    // paid anyway, and exact text is the only honest comparison left.
    return stored === requested;
  }
}
