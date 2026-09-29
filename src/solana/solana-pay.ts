import { SOLANA_PAY_SCHEME } from '@/solana/solana.constants';

/** What a Solana Pay transfer request carries. */
export interface SolanaPayRequest {
  recipient: string;
  /** Decimal, in the asset's own units (SOL, not lamports). Omit to let the payer enter it. */
  amount?: string;
  /** The SPL mint, for a token transfer; omit for SOL. */
  splToken?: string;
  /**
   * The intent's reference key. The wallet adds it to the transfer as a
   * read-only account, which is what makes the payment findable on-chain by
   * `getSignaturesForAddress` — Solana's equivalent of a Stellar MEMO_ID.
   */
  reference: string;
  /** Shown to the payer. */
  message?: string;
  /** Recorded on-chain by the SPL Memo program — the merchant's own id. */
  memo?: string;
}

/**
 * A Solana Pay transfer request URI (`solana:<recipient>?…`), as specified by
 * the Solana Pay spec. Pure: everything in it comes from the intent.
 */
export function solanaPayUri(request: SolanaPayRequest): string {
  const params = new URLSearchParams();
  if (request.amount !== undefined) params.set('amount', request.amount);
  if (request.splToken !== undefined) params.set('spl-token', request.splToken);
  params.set('reference', request.reference);
  if (request.message !== undefined) params.set('message', request.message);
  if (request.memo !== undefined) params.set('memo', request.memo);
  return `${SOLANA_PAY_SCHEME}${request.recipient}?${params.toString()}`;
}
