import { createHash, randomBytes } from 'crypto';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import { PAYMENT_PAYER_TOKEN_BYTES } from '@/payment-intents/payment-intents.constants';
import { isPaymentNetwork } from '@/payment-intents/payment-networks';

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
}

/** Who the receipt goes to, and whether that session proved it paid. */
export interface ReceiptRecipient<T> {
  session: T;
  /** A proof matched: only then is the payer linked to a customer. */
  proven: boolean;
}

function same(caseInsensitive: boolean, a: string, b: string): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/* The earliest proof among matches: the payer's wallet answers its own
   transaction before anyone could copy it from the chain. */
function earliest<T extends PayerSessionFields>(matches: T[]): T | undefined {
  return [...matches].sort(
    (a, b) => (a.provenAt?.getTime() ?? 0) - (b.provenAt?.getTime() ?? 0),
  )[0];
}

/**
 * Where the receipt of a payment made with the link itself (not a deposit)
 * goes, among the checkout sessions that gave an email. A `sent` report proves
 * nothing (anyone holding a token can send one), so only a proof decides:
 * the session whose registered transaction is the settlement's, else the one
 * whose registered account is the settlement's source (the earliest proof
 * wins either way). Without a match, the only session when exactly one gave
 * an email (a receipt of on-chain facts, no customer link); otherwise nobody.
 */
export function receiptRecipient<T extends PayerSessionFields>(
  sessions: readonly T[],
  settled: PaymentSettlementFields,
): ReceiptRecipient<T> | null {
  if (isPaymentNetwork(settled.chain)) {
    const rules = CROSS_CHAIN_NETWORKS[settled.chain];
    const tx =
      settled.txHash && rules.txId.isValid(settled.txHash)
        ? rules.txId.normalize(settled.txHash)
        : null;
    const byTx = tx
      ? earliest(
          sessions.filter(
            (s) => s.walletTxHash !== null && same(true, s.walletTxHash, tx),
          ),
        )
      : undefined;
    if (byTx) return { session: byTx, proven: true };
    const source =
      settled.source && rules.address.isValid(settled.source)
        ? rules.address.normalize(settled.source)
        : null;
    const byAddress = source
      ? earliest(
          sessions.filter(
            (s) =>
              s.walletAddress !== null &&
              same(rules.address.caseInsensitive, s.walletAddress, source),
          ),
        )
      : undefined;
    if (byAddress) return { session: byAddress, proven: true };
  }
  return sessions.length === 1 ? { session: sessions[0], proven: false } : null;
}
