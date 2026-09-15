import type { LiquidityPoolOperation } from '@generated/prisma/client';
import { sameAmount } from '@/swaps/swap-math';

/**
 * The parts of a deposit request that decide what gets signed, resolved the way
 * the service stores them: the pair in canonical order (A < B), the caller's
 * amounts moved along with their assets, the slippage defaulted from config.
 *
 * An amount the caller left out is `null`. The service derives it from the
 * pool's reserves at build time, so it is not the caller's choice and a retry
 * must not be compared on it — see {@link liquidityOperationMatchesRequest}.
 */
export interface DepositRequestTerms {
  kind: 'DEPOSIT';
  network: string;
  source: string;
  poolId: string;
  assetA: string;
  assetAIssuer: string | null;
  assetB: string;
  assetBIssuer: string | null;
  amountA: string | null;
  amountB: string | null;
  slippageBps: number;
  memo: string | null;
}

/**
 * The parts of a withdraw request that decide what gets signed. The reserve
 * minimums and the commission are absent for the same reason the quote is
 * absent from a swap's terms: they come from Horizon and the plan, not from the
 * caller.
 */
export interface WithdrawRequestTerms {
  kind: 'WITHDRAW';
  network: string;
  source: string;
  poolId: string;
  shares: string;
  slippageBps: number;
  memo: string | null;
}

export type LiquidityRequestTerms = DepositRequestTerms | WithdrawRequestTerms;

/**
 * A stored operation as the comparison reads it.
 *
 * `memo` is the row's `memo` column when that is set. A null column is
 * ambiguous: the caller supplied no memo, or the row was built before the column
 * existed and its memo lives only in the envelope. So the service answers a
 * null from the stored envelope, which is authoritative for both. `undefined`
 * means the column was null and the envelope could not be read. That never
 * happens for a row this service built, and when it does nothing about the row
 * can be vouched for, so it matches nothing.
 */
export type StoredLiquidityTerms = Pick<
  LiquidityPoolOperation,
  | 'kind'
  | 'network'
  | 'source'
  | 'poolId'
  | 'assetA'
  | 'assetAIssuer'
  | 'assetB'
  | 'assetBIssuer'
  | 'amountA'
  | 'amountB'
  | 'shares'
  | 'slippageBps'
> & { memo: string | null | undefined };

/**
 * Whether a stored liquidity operation is the one this request would have
 * built — the check an `Idempotency-Key` replay must pass before it hands the
 * stored XDR back.
 *
 * Same hole as swaps (see `swapMatchesRequest`): under the shared public API key
 * every wallet is one consumer, so a key used by one caller was a key anyone
 * could pre-empt — a withdraw from the victim's position, or a deposit of the
 * victim's funds, waiting to be returned to them. The `kind` is part of the
 * match too: the key index does not know deposits from withdrawals, so a
 * withdraw request used to be answered with a deposit.
 *
 * An amount omitted from a deposit matches whatever the stored row holds. It
 * was derived from the pool price when the row was built, and a deposit at the
 * pool price is value-neutral whichever cap it carries. Comparing it would
 * make every honest retry of a one-sided deposit a 409 the moment the reserves
 * moved.
 */
export function liquidityOperationMatchesRequest(
  stored: StoredLiquidityTerms,
  request: LiquidityRequestTerms,
): boolean {
  if (stored.memo === undefined) return false;
  if (
    stored.kind !== request.kind ||
    stored.network !== request.network ||
    stored.source !== request.source ||
    stored.poolId !== request.poolId ||
    stored.slippageBps !== request.slippageBps ||
    stored.memo !== request.memo
  ) {
    return false;
  }
  if (request.kind === 'WITHDRAW') {
    return stored.shares !== null && sameAmount(stored.shares, request.shares);
  }
  return (
    stored.assetA === request.assetA &&
    stored.assetAIssuer === request.assetAIssuer &&
    stored.assetB === request.assetB &&
    stored.assetBIssuer === request.assetBIssuer &&
    (request.amountA === null || sameAmount(stored.amountA, request.amountA)) &&
    (request.amountB === null || sameAmount(stored.amountB, request.amountB))
  );
}
