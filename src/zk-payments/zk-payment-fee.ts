import { fromStroops, toStroops } from '@/swaps/swap-math';
import {
  BPS_DENOMINATOR,
  ZK_PAYMENT_MIN_FEE_STROOPS,
} from '@/zk-payments/zk-payments.constants';

/** How one gross amount splits between the merchant and Cosmos Pay. */
export interface ZkPaymentSplit {
  /** What the payer pays in total, in stroops. */
  amountStroops: bigint;
  /** Cosmos Pay's commission, in stroops. */
  feeStroops: bigint;
  /** What the merchant receives, in stroops: `amount - fee`. */
  netStroops: bigint;
  /** The same three, as the decimal strings the API speaks. */
  amount: string;
  feeAmount: string;
  netAmount: string;
}

/**
 * Splits a gross amount into the merchant's net and Cosmos Pay's fee.
 *
 * `fee = ceil(amount * bps / 10000)`, at least {@link ZK_PAYMENT_MIN_FEE_STROOPS}:
 * rounding UP, so the commission is never shaved off by an amount that does not
 * divide evenly, and never zero. Everything is integer stroops; a float never
 * touches money.
 *
 * Returns null when the net would be zero or negative: a payment that pays the
 * merchant nothing is not a payment, and the caller refuses it as
 * `invalid_amount`.
 *
 * @throws RangeError when `amount` is not a Stellar amount (7 places at most),
 *   which the DTO already guarantees.
 */
export function splitZkPayment(
  amount: string,
  feeBps: number,
): ZkPaymentSplit | null {
  const amountStroops = toStroops(amount);
  const feeStroops = zkPaymentFee(amountStroops, feeBps);
  const netStroops = amountStroops - feeStroops;
  if (netStroops <= 0n) return null;
  return {
    amountStroops,
    feeStroops,
    netStroops,
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
