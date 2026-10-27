import {
  assertMerchantFeeCovered,
  type MerchantFeeTerms,
  splitMerchantFee,
} from '@/common/merchant-fee/merchant-fee';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import {
  BPS_DENOMINATOR,
  ZK_PAYMENT_MIN_FEE_STROOPS,
} from '@/zk-payments/zk-payments.constants';

/** How one gross amount splits between the merchant, Cosmos Pay and a merchant fee. */
export interface ZkPaymentSplit {
  /** What the payer pays in total, in stroops. */
  amountStroops: bigint;
  /** Cosmos Pay's commission, in stroops. */
  feeStroops: bigint;
  /** What the merchant receives, in stroops: `amount - fee - merchantFee`. */
  netStroops: bigint;
  /** The merchant fee's transfer, in stroops: 0 without one. */
  merchantFeeStroops: bigint;
  /** The same three, as the decimal strings the API speaks. */
  amount: string;
  feeAmount: string;
  netAmount: string;
}

/**
 * Splits a gross amount into the merchant's net, Cosmos Pay's fee and, when the
 * request named one, the merchant fee.
 *
 * `fee = ceil(amount * bps / 10000)`, at least {@link ZK_PAYMENT_MIN_FEE_STROOPS}:
 * rounding UP, so the commission is never shaved off by an amount that does not
 * divide evenly, and never zero. Everything is integer stroops; a float never
 * touches money.
 *
 * The commission is a share of the request's `amount` either way. The merchant
 * fee (`splitMerchantFee`) comes out of it (`recipient`: the payer pays
 * `amount`) or is paid on top (`payer`: the payer pays `amount` plus it), so
 * the stored `amount` is always `netAmount + feeAmount + merchantFee`.
 *
 * Returns null when the net would be zero or negative: a payment that pays the
 * merchant nothing is not a payment, and the caller refuses it as
 * `invalid_amount`.
 *
 * @throws ApiError `invalid_amount` when the merchant fee charges nothing or
 *   takes the whole amount (`assertMerchantFeeCovered`).
 * @throws RangeError when `amount` is not a Stellar amount (7 places at most),
 *   which the DTO already guarantees.
 */
export function splitZkPayment(
  amount: string,
  feeBps: number,
  merchant: MerchantFeeTerms | null = null,
): ZkPaymentSplit | null {
  const requested = toStroops(amount);
  const feeStroops = zkPaymentFee(requested, feeBps);
  const merchantSplit = splitMerchantFee(requested, merchant);
  assertMerchantFeeCovered(merchantSplit, merchant);
  const amountStroops = merchantSplit.total;
  const netStroops = merchantSplit.net - feeStroops;
  if (netStroops <= 0n) return null;
  return {
    amountStroops,
    feeStroops,
    netStroops,
    merchantFeeStroops: merchantSplit.fee,
    amount: fromStroops(amountStroops),
    feeAmount: fromStroops(feeStroops),
    netAmount: fromStroops(netStroops),
  };
}

/** The commission on `amountStroops` at `feeBps`, rounded up, never below the floor. */
export function zkPaymentFee(amountStroops: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new RangeError(
      `feeBps must be a non-negative integer, got ${feeBps}`,
    );
  }
  const product = amountStroops * BigInt(feeBps);
  const ceil = (product + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  return ceil < ZK_PAYMENT_MIN_FEE_STROOPS ? ZK_PAYMENT_MIN_FEE_STROOPS : ceil;
}
