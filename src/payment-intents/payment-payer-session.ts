import { createHash, randomBytes } from 'crypto';
import { PAYMENT_PAYER_TOKEN_BYTES } from '@/payment-intents/payment-intents.constants';

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
  /** The last `sent` this session reported; null if it never did. */
  sentAt: Date | null;
  createdAt: Date;
}

/**
 * Where the receipt of a payment made with the link itself (not a deposit)
 * goes, among the checkout sessions that gave an email: the session that
 * reported `sent` most recently (events are taken only while the link is
 * open, so before it settled); with no such report, the one email when every
 * session gave the same; otherwise nobody, since the payer cannot be told
 * apart from anyone else who opened the link. Null then: no receipt and no
 * customer link, and the merchant sees the emails as given by payers.
 */
export function receiptRecipient<T extends PayerSessionFields>(
  sessions: readonly T[],
): T | null {
  const reported = sessions
    .filter((s): s is T & { sentAt: Date } => s.sentAt !== null)
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  if (reported.length > 0) return reported[0];
  const emails = new Set(sessions.map((s) => s.email.toLowerCase()));
  if (emails.size !== 1) return null;
  return [...sessions].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
}
