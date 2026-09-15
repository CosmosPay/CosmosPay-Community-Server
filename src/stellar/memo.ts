import { randomBytes } from 'node:crypto';
import { Memo, TransactionBuilder } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { MAX_UINT64 } from '@/stellar/stellar.constants';

/**
 * Validates a caller-supplied MEMO_ID, or `null` when none was given.
 *
 * Both swaps and liquidity pools carried this, along with their own copy of the
 * constant — so a change to the rule had two places to be made and one place to
 * be forgotten.
 */
export function resolveMemoId(provided?: string): string | null {
  if (provided === undefined) return null;
  if (!/^\d+$/.test(provided) || BigInt(provided) > MAX_UINT64) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidMemo,
      'memo must be a MEMO_ID: a numeric uint64',
    );
  }
  return provided;
}

/**
 * {@link resolveMemoId} for a caller whose memo is mandatory: the caller's
 * MEMO_ID when given, otherwise a random one.
 *
 * Payment intents are that caller — the memo is what ties an on-chain payment
 * back to its intent, and half of the create's idempotency key — and this branch
 * lived privately in their service, beside a third copy of the validation above.
 * A supplied memo, even an empty one, is validated rather than replaced, so a
 * malformed memo is a 400 and never a silently different one.
 *
 * The minted value is plain decimal with no leading zeros because that is the
 * only spelling Horizon reports a memo in, and the verifier compares memos as
 * strings.
 */
export function resolveOrMintMemoId(provided?: string): string {
  // Eight random bytes are exactly a uint64: every draw is a valid MEMO_ID and
  // none of the range is out of reach.
  return (
    resolveMemoId(provided) ??
    BigInt(`0x${randomBytes(8).toString('hex')}`).toString()
  );
}

/**
 * Applies the caller's MEMO_ID when given, otherwise a MEMO_TEXT commission
 * label when a commission was actually collected — so the platform fee is
 * identifiable on-chain. No memo when neither applies.
 */
export function applyMemo(
  builder: TransactionBuilder,
  memoId: string | null,
  commissionLabel?: string | null,
): void {
  if (memoId) {
    builder.addMemo(Memo.id(memoId));
    return;
  }
  if (commissionLabel) {
    builder.addMemo(Memo.text(commissionLabel));
  }
}
