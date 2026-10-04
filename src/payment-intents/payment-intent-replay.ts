import type { PaymentIntent } from '@generated/prisma/client';
import { decimalPlaces, parseUnits } from '@/chains/units';

/**
 * Everything a create request fixes about the payment it describes: the columns
 * that end up inside the intent's `uri` (and so its QR), plus the kind, chain
 * and network that decide how that URI is built and read.
 */
export type PaymentIntentTerms = Pick<
  PaymentIntent,
  | 'kind'
  | 'chain'
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
 * `chain` is compared like the rest: memo "42" on Stellar and memo "42" on
 * Solana are two different payments, and a replay must not hand back one for
 * the other.
 *
 * Amounts are compared as exact decimals, so "2" and "2.0000000" are the same
 * request on every chain.
 */
export function isSameIntentRequest(
  stored: PaymentIntentTerms,
  requested: PaymentIntentTerms,
): boolean {
  return (
    stored.kind === requested.kind &&
    stored.chain === requested.chain &&
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
  // Scaled to the finer of the two, which neither can exceed: an exact integer
  // comparison, never a float's.
  const places = Math.max(decimalPlaces(stored), decimalPlaces(requested));
  try {
    return parseUnits(stored, places) === parseUnits(requested, places);
  } catch {
    // Not a decimal on one side — only a row older than the DTO patterns.
    // Exact text is the only honest comparison left.
    return stored === requested;
  }
}
