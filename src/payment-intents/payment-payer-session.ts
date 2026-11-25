import { createHash, randomBytes } from 'crypto';
import {
  PAYMENT_PAYER_PROOF_MARGIN_MS,
  PAYMENT_PAYER_TOKEN_BYTES,
} from '@/payment-intents/payment-intents.constants';
import {
  isPaymentNetwork,
  PAYMENT_NETWORK_RULES,
} from '@/payment-intents/payment-networks';

/**
 * A hosted checkout session's credential: random, handed to that session's
 * browser once (`POST /v1/payment-links/{id}/payer`) and never stored or
 * logged; only {@link payerTokenHash} of it is kept.
 */
export function newPayerToken(): string {
  return randomBytes(PAYMENT_PAYER_TOKEN_BYTES).toString('base64url');
}

/** What a session token is stored and looked up by: its SHA-256, hex. */
export function payerTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A checkout session as the receipt reads it. */
export interface PayerSessionFields {
  email: string;
  lang: string;
  /** The account its wallet said it pays from (normalized), or null. */
  walletAddress: string | null;
  /** The transaction its wallet answered (normalized), or null. */
  walletTxHash: string | null;
  /** When it registered that proof. */
  provenAt: Date | null;
}

/** What the settlement of a payment with the link itself recorded. */
export interface PaymentSettlementFields {
  chain: string;
  txHash: string | null;
  /** The account that paid, as the settlement recorded it; null if unknown. */
  source: string | null;
  /**
   * When the settling transaction closed on-chain; a proof counts only when
   * registered at least `PAYMENT_PAYER_PROOF_MARGIN_MS` before it. Null when
   * the chain's time is not known (a Monad or Arc deposit-address sweep, whose
   * deposit was public before it): then no proof counts (fail closed).
   */
  paidAt: Date | null;
}

/** Who the receipt goes to, and whether that session proved it paid. */
export interface ReceiptRecipient<T> {
  session: T;
  /** One session's proof matched: only then is the payer linked to a customer. */
  proven: boolean;
}

function same(caseInsensitive: boolean, a: string, b: string): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Where the receipt of a payment made with the link itself (not a deposit)
 * goes, among the checkout sessions that gave an email. A `sent` report proves
 * nothing (anyone holding a token can send one), so only a proof decides: the
 * session whose registered transaction is the settlement's. A registered
 * account proves nothing: an address is public long before it pays (every
 * earlier payment shows it), so anyone could register a merchant's known payer
 * on a link ahead of time and take that payer's receipt and customer link.
 * A transaction hash exists only once its payer signs it. A proof counts only
 * when registered `PAYMENT_PAYER_PROOF_MARGIN_MS` before the transaction's
 * on-chain time (the hash is public from then on), never when that time is
 * unknown, and two sessions matching the same proof prove nothing. Without
 * exactly one match: the only session when exactly one gave an email (a
 * receipt of on-chain facts, no customer link); otherwise nobody.
 */
export function receiptRecipient<T extends PayerSessionFields>(
  sessions: readonly T[],
  settled: PaymentSettlementFields,
): ReceiptRecipient<T> | null {
  if (isPaymentNetwork(settled.chain)) {
    const rules = PAYMENT_NETWORK_RULES[settled.chain];
    const cutoff =
      settled.paidAt === null
        ? null
        : settled.paidAt.getTime() - PAYMENT_PAYER_PROOF_MARGIN_MS;
    const inTime =
      cutoff === null
        ? []
        : sessions.filter(
            (s) => s.provenAt !== null && s.provenAt.getTime() < cutoff,
          );
    const tx =
      settled.txHash && rules.txId.isValid(settled.txHash)
        ? rules.txId.normalize(settled.txHash)
        : null;
    const byTx = tx
      ? inTime.filter(
          (s) => s.walletTxHash !== null && same(true, s.walletTxHash, tx),
        )
      : [];
    if (byTx.length === 1) return { session: byTx[0], proven: true };
  }
  return sessions.length === 1 ? { session: sessions[0], proven: false } : null;
}
