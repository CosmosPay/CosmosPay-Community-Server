import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { BalanceEntry } from '@/stellar/account-loader.service';
import {
  minimumBalanceStroops,
  nativeBalanceStroops,
  nativeSellingLiabilitiesStroops,
  type ReserveFields,
} from '@/stellar/account-reserve';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import { USDT0_ASSET_CODE, USDT0_ISSUER } from '@/usdt0/usdt0.constants';

/**
 * Whether the source of a USDT0 transfer can pay for it, asked of the account
 * Horizon returned before anything is built or signed. Pure, so each refusal is
 * pinned by a spec. Both are `400`s that say what to do, because the network
 * would otherwise take the fee and fail the transaction.
 */

/**
 * The account must trust USDT0 and hold what the OFT takes from it (the amount
 * without its dust), net of what its open offers already promise to sell.
 */
export function assertHoldsUsdt0(
  balances: BalanceEntry[],
  address: string,
  amountSentLd: bigint,
): void {
  const line = balances.find(
    (b) => b.asset_code === USDT0_ASSET_CODE && b.asset_issuer === USDT0_ISSUER,
  );
  if (!line) {
    throw ApiError.badRequest(
      ApiErrorCode.TrustlineMissing,
      `Account ${address} has no trustline for ${USDT0_ASSET_CODE}:${USDT0_ISSUER}, ` +
        'so it holds no USDT0 to send. Add the trustline and receive USDT0 ' +
        'first, then try again.',
    );
  }
  const balance = toStroops(line.balance ?? '0');
  const offers = toStroops(line.selling_liabilities ?? '0');
  const spendable = balance > offers ? balance - offers : 0n;
  if (spendable >= amountSentLd) return;
  throw ApiError.badRequest(
    ApiErrorCode.InsufficientBalance,
    `Account ${address} can send ${fromStroops(spendable)} USDT0` +
      (offers > 0n
        ? ` (${fromStroops(offers)} of its ${fromStroops(balance)} are held by its open offers)`
        : '') +
      `, but this transfer takes ${fromStroops(amountSentLd)}.`,
  );
}

/** What the transaction spends in XLM, in stroops. */
export interface XlmSpend {
  address: string;
  /** The `native_fee` offered to LayerZero: the quote plus the buffer. */
  nativeFeeLimit: bigint;
  /** The transaction's whole fee: inclusion plus Soroban resources. */
  networkFee: bigint;
}

/**
 * The XLM balance must cover, at once: the account's minimum balance (the
 * network's reserve, from Horizon's subentry and sponsorship counts), the XLM
 * its open offers hold, the network fee, and the whole LayerZero fee limit.
 * The endpoint returns what it does not charge within the same transaction,
 * but the account must hold all of it when the contract moves it.
 */
export function assertCanPayXlm(
  account: ReserveFields,
  balances: BalanceEntry[],
  spend: XlmSpend,
): void {
  const balance = nativeBalanceStroops(balances);
  const minimum = minimumBalanceStroops(account);
  const offers = nativeSellingLiabilitiesStroops(balances);
  const needed = minimum + offers + spend.nativeFeeLimit + spend.networkFee;
  if (balance >= needed) return;

  const parts = [`its minimum balance of ${fromStroops(minimum)} XLM`];
  if (offers > 0n) {
    parts.push(`${fromStroops(offers)} XLM held by its open offers`);
  }
  parts.push(
    `the ${fromStroops(spend.nativeFeeLimit)} XLM LayerZero fee limit`,
  );
  parts.push(`the ${fromStroops(spend.networkFee)} XLM network fee`);
  throw ApiError.badRequest(
    ApiErrorCode.InsufficientBalance,
    `Account ${spend.address} cannot pay this transfer's fees in XLM: it ` +
      `needs ${fromStroops(needed)} XLM (${parts.join(', ')}) but holds ` +
      `${fromStroops(balance)} XLM. Add at least ` +
      `${fromStroops(needed - balance)} XLM to it, then try again. What ` +
      'LayerZero does not charge of its fee limit comes back in the same ' +
      'transaction.',
  );
}
