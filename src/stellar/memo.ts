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
