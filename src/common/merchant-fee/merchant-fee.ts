import { formatUnits, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  DEFAULT_MERCHANT_FEE_PAYER,
  MAX_MERCHANT_FEE_BPS,
  MERCHANT_FEE_PAYERS,
  type MerchantFeePayer,
} from '@/common/merchant-fee/merchant-fee.constants';
import type { MerchantFeeDto } from '@/common/merchant-fee/merchant-fee.dto';

/**
 * The merchant fee's rules, the same for every operation that takes one: the
 * request read into exact base units, how it splits an amount, and the record
 * a row keeps of it. Pure, so a spec pins the money without a Nest container;
 * each service only supplies the asset's decimals and the wallet's address rule.
 */

/** A merchant fee as an operation applies it, the fixed part in base units. */
export interface MerchantFeeTerms {
  bps: number;
  fixed: bigint;
  wallet: string;
  paidBy: MerchantFeePayer;
}

/** The address rule the fee's wallet must meet: the chain the fee travels on. */
export interface MerchantFeeWalletRule {
  isValid(address: string): boolean;
  normalize(address: string): string;
  expected: string;
}

/**
 * How a merchant fee splits an amount, in base units: `total` is what the
 * payer sends, `net` what goes on (to the receiver, into the swap), `fee` what
 * the merchant's wallet gets. `total = net + fee` either way.
 */
export interface MerchantFeeSplit {
  fee: bigint;
  net: bigint;
  total: bigint;
}

/**
 * What a row keeps and publishes: the terms as asked, the amount charged and
 * where it went. Amounts are decimals in `asset`, as the row's other amounts.
 */
export interface MerchantFeeRecord {
  bps: number;
  fixed: string;
  amount: string;
  asset: string;
  wallet: string;
  paidBy: MerchantFeePayer;
}

/**
 * The request's merchant fee, checked against the operation: the fixed part in
 * the asset's decimals, the wallet in the chain's address rule. Null when the
 * request names none. A fee of nothing (no percentage, no fixed part) is a
 * mistake in the request, not a fee, and is refused.
 */
export function resolveMerchantFee(
  dto: MerchantFeeDto | undefined,
  decimals: number,
  rule: MerchantFeeWalletRule,
): MerchantFeeTerms | null {
  if (!dto) return null;
  const bps = dto.bps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_MERCHANT_FEE_BPS) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `merchantFee.bps must be an integer from 0 to ${MAX_MERCHANT_FEE_BPS}`,
    );
  }
  let fixed: bigint;
  try {
    fixed = parseUnits(dto.fixed ?? '0', decimals);
  } catch {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      `merchantFee.fixed must be a decimal with at most ${decimals} decimal places for this asset`,
    );
  }
  if (bps === 0 && fixed === 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'merchantFee needs bps or fixed above zero',
    );
  }
  const wallet = dto.wallet.trim();
  if (!rule.isValid(wallet)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `merchantFee.wallet must be ${rule.expected}`,
    );
  }
  return {
    bps,
    fixed,
    wallet: rule.normalize(wallet),
    paidBy: dto.paidBy ?? DEFAULT_MERCHANT_FEE_PAYER,
  };
}

/**
 * Splits `amount` (base units): the fee is `amount × bps / 10,000`, rounded
 * down so the payer is never charged above the stated rate, plus the fixed
 * part. Deducted (`recipient`) it comes out of `amount`; added (`payer`) it is
 * sent on top. No fee leaves the amount whole.
 */
export function splitMerchantFee(
  amount: bigint,
  terms: MerchantFeeTerms | null,
): MerchantFeeSplit {
  if (!terms) return { fee: 0n, net: amount, total: amount };
  const fee = (amount * BigInt(terms.bps)) / 10_000n + terms.fixed;
  return terms.paidBy === 'payer'
    ? { fee, net: amount, total: amount + fee }
    : { fee, net: amount - fee, total: amount };
}

/**
 * Refuses a split that leaves nothing to go on (a deducted fee as large as the
 * amount) and a fee the request named that charges nothing (a percentage that
 * rounds to zero on a small amount): a payment of zero is malformed on Stellar
 * and an empty transfer anywhere else. Said before anything is built, so the
 * payer is never asked to sign a payment that would hand everything to the fee.
 */
export function assertMerchantFeeCovered(
  split: MerchantFeeSplit,
  terms: MerchantFeeTerms | null,
): void {
  // No fee asked: nothing of the amount goes to one, whatever the amount.
  if (!terms) return;
  if (split.fee <= 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      'amount is too small for the merchant fee to charge anything',
    );
  }
  if (split.net <= 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      'amount is too small to cover the merchant fee',
    );
  }
}

/** The record a row keeps of the fee it charged. */
export function merchantFeeRecord(
  terms: MerchantFeeTerms,
  fee: bigint,
  decimals: number,
  asset: string,
): MerchantFeeRecord {
  return {
    bps: terms.bps,
    fixed: formatUnits(terms.fixed, decimals),
    amount: formatUnits(fee, decimals),
    asset,
    wallet: terms.wallet,
    paidBy: terms.paidBy,
  };
}

/** A stored record read back, or null when the column holds none (or not one). */
export function readMerchantFeeRecord(
  value: unknown,
): MerchantFeeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const ok =
    typeof r.bps === 'number' &&
    typeof r.fixed === 'string' &&
    typeof r.amount === 'string' &&
    typeof r.asset === 'string' &&
    typeof r.wallet === 'string' &&
    (MERCHANT_FEE_PAYERS as readonly unknown[]).includes(r.paidBy);
  return ok ? (r as unknown as MerchantFeeRecord) : null;
}

/**
 * Whether a stored row was built from these terms, for an `Idempotency-Key`
 * replay: the same percentage, fixed part, wallet and payer. A row with a fee
 * never matches a request without one, nor the other way round.
 */
export function sameMerchantFee(
  stored: unknown,
  terms: MerchantFeeTerms | null,
  decimals: number,
): boolean {
  const record = readMerchantFeeRecord(stored);
  if (!terms) return record === null;
  if (!record) return false;
  let fixed: bigint;
  try {
    fixed = parseUnits(record.fixed, decimals);
  } catch {
    return false;
  }
  return (
    record.bps === terms.bps &&
    fixed === terms.fixed &&
    record.wallet === terms.wallet &&
    record.paidBy === terms.paidBy
  );
}
