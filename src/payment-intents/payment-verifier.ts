import type { PaymentIntent } from '@generated/prisma/client';

export interface VerificationResult {
  valid: boolean;
  txHash?: string;
  reason?: string;
  /** The payer (source) account of the matched on-chain payment, when valid. */
  payer?: string;
  /**
   * The transaction is this intent's payment — it carries the intent's
   * identifier (Stellar memo, Solana reference) and pays its destination — but
   * it failed on-chain. Only this may settle an intent as FAILED; every other
   * invalid result is a mismatch.
   */
  failedOnChain?: boolean;
  /**
   * Where a scan got to, for a chain that pages through history by block
   * (Monad). The observer stores it on the intent so the next tick resumes
   * there instead of rescanning.
   */
  nextCursor?: string;
}

/**
 * What confirms, on one chain, that a transaction pays an intent. One per
 * chain; the payment-intents service and the observer pick it by the intent's
 * `chain`, so the settlement rule for a chain lives in exactly one class.
 */
export interface PaymentVerifier {
  /** Does this transaction (hash / signature) pay the intent? */
  verifyByHash(
    intent: PaymentIntent,
    txHash: string,
  ): Promise<VerificationResult>;
  /** Look for the intent's payment without being told the transaction. */
  findMatchingPayment(intent: PaymentIntent): Promise<VerificationResult>;
}
