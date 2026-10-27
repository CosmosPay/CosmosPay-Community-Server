import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  merchantFeeRecord,
  type MerchantFeeRecord,
  type MerchantFeeTerms,
  readMerchantFeeRecord,
  resolveMerchantFee,
} from '@/common/merchant-fee/merchant-fee';
import { MERCHANT_FEE_BPS_DENOMINATOR } from '@/common/merchant-fee/merchant-fee.constants';
import type { MerchantFeeDto } from '@/common/merchant-fee/merchant-fee.dto';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';
import { fromStroops } from '@/swaps/swap-math';

/**
 * The merchant fee on a liquidity operation. A deposit or a withdrawal moves
 * two assets at once, so the fee is a percentage of EACH: `bps` of asset A to
 * the wallet in asset A, and of asset B in asset B, one payment per asset in
 * the operation's own transaction. A fixed part has no single asset to be
 * counted in, so it is refused here rather than guessed.
 */

/**
 * The record a liquidity row keeps: the shared record, whose `amount` and
 * `asset` are asset A's leg, plus asset B's.
 */
export interface LiquidityMerchantFeeRecord extends MerchantFeeRecord {
  amountB: string;
  assetB: string;
}

/** The request's merchant fee, checked: a Stellar wallet, a percentage only. */
export function resolveLiquidityMerchantFee(
  dto: MerchantFeeDto | undefined,
): MerchantFeeTerms | null {
  const terms = resolveMerchantFee(
    dto,
    STELLAR_DECIMALS,
    CHAIN_ADDRESS_RULES.stellar,
  );
  if (terms && terms.fixed > 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'merchantFee.fixed is not available on liquidity operations: they move ' +
        'two assets, so the fee is a percentage (bps) of each',
    );
  }
  return terms;
}

/**
 * The fee on each asset, in stroops: `amount × bps / 10,000`, rounded down so
 * the payer is never charged above the stated rate. One side may round to
 * nothing (it then has no payment); both rounding to nothing is refused, as a
 * merchant fee that charges nothing is everywhere.
 */
export function liquidityMerchantFee(
  terms: MerchantFeeTerms,
  amountA: bigint,
  amountB: bigint,
): { feeA: bigint; feeB: bigint } {
  const bps = BigInt(terms.bps);
  const feeA = (amountA * bps) / MERCHANT_FEE_BPS_DENOMINATOR;
  const feeB = (amountB * bps) / MERCHANT_FEE_BPS_DENOMINATOR;
  if (feeA <= 0n && feeB <= 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      'amount is too small for the merchant fee to charge anything',
    );
  }
  return { feeA, feeB };
}

/** The record a row keeps of the fee it charged on both assets. */
export function liquidityMerchantFeeRecord(
  terms: MerchantFeeTerms,
  fees: { feeA: bigint; feeB: bigint },
  assetA: string,
  assetB: string,
): LiquidityMerchantFeeRecord {
  return {
    ...merchantFeeRecord(terms, fees.feeA, STELLAR_DECIMALS, assetA),
    amountB: fromStroops(fees.feeB),
    assetB,
  };
}

/** A stored record read back, or null when the column holds none (or not one). */
export function readLiquidityMerchantFee(
  value: unknown,
): LiquidityMerchantFeeRecord | null {
  const base = readMerchantFeeRecord(value);
  if (!base) return null;
  const r = value as Record<string, unknown>;
  return typeof r.amountB === 'string' && typeof r.assetB === 'string'
    ? { ...base, amountB: r.amountB, assetB: r.assetB }
    : null;
}
