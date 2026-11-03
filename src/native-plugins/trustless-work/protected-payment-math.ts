import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import {
  TRUSTLESS_WORK_BPS_DENOMINATOR,
  TRUSTLESS_WORK_FEE_BPS,
} from '@/native-plugins/trustless-work/trustless-work.constants';

/**
 * The money arithmetic of a protected payment, the way the contract does it.
 * Pure, in the token's minor units (USDC on Stellar has 7 decimals, so the
 * repo's stroop helpers apply as they are).
 */

/** What one distribution of `amount` pays, after the contract's two fees. */
export interface FeeSplit {
  trustlessWork: bigint;
  platform: bigint;
  net: bigint;
}

/**
 * The contract's `calculate_standard_fees`: each fee is `amount * bps / 10000`
 * rounded down, and the rest is paid out. A release pays the receiver this on
 * the whole amount; a dispute resolution applies it to each distribution in
 * proportion, so a refund reaches the buyer net of the same 1.95%.
 */
export function feeSplit(amount: bigint, platformFeeBps: number): FeeSplit {
  const trustlessWork =
    (amount * BigInt(TRUSTLESS_WORK_FEE_BPS)) / TRUSTLESS_WORK_BPS_DENOMINATOR;
  const platform =
    (amount * BigInt(platformFeeBps)) / TRUSTLESS_WORK_BPS_DENOMINATOR;
  return { trustlessWork, platform, net: amount - trustlessWork - platform };
}

/**
 * What a resolution distribution of `amount` (out of a resolution of `total`)
 * pays its recipient: the contract's `calculate_and_distribute_fees`, which
 * takes each recipient's share of the two fees computed on the total, rounded
 * down.
 */
export function distributionNet(
  amount: bigint,
  total: bigint,
  platformFeeBps: number,
): bigint {
  if (total <= 0n) return 0n;
  const fees = feeSplit(total, platformFeeBps);
  const tw = (amount * fees.trustlessWork) / total;
  const platform = (amount * fees.platform) / total;
  return amount - tw - platform;
}

/** The total fee in basis points: Trustless Work's 30 plus the platform's. */
export function totalFeeBps(platformFeeBps: number): number {
  return TRUSTLESS_WORK_FEE_BPS + platformFeeBps;
}

/**
 * An amount as Trustless Work's API takes it: a JSON number in token units.
 * The decimal string of the stroops, parsed once, so `100.1` is `100.1` and not
 * a float computed from another float.
 */
export function apiAmount(stroops: bigint): number {
  return Number(fromStroops(stroops));
}

/**
 * The platform fee as Trustless Work's API takes it: a percent (`1` is 1%),
 * which the API stores in the contract as basis points. 165 bps is `1.65`.
 */
export function apiPlatformFee(platformFeeBps: number): number {
  return platformFeeBps / 100;
}

/**
 * A balance Trustless Work's indexer reports as a number (token units) or a
 * string, in stroops; null when it is neither.
 */
export function balanceStroops(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+(\.\d{1,7})?$/.test(value)) {
    return toStroops(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return toStroops(value.toFixed(7));
  }
  return null;
}

/** The decided split of a dispute, in stroops. */
export interface Split {
  buyer: bigint;
  merchant: bigint;
}

/**
 * The split a resolution may pay, checked: two non-negative amounts, not both
 * zero, adding up to exactly the contract's balance (the contract refuses any
 * other sum). Only ever the protected payment's own buyer and merchant: the
 * contract would pay any address, so this is the code guard that keeps it to
 * them (it does not help against a leaked resolver key).
 */
export function checkedSplit(split: Split, balance: bigint): Split {
  if (split.buyer < 0n || split.merchant < 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      'buyerAmount and merchantAmount must not be negative',
    );
  }
  if (balance <= 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidStateTransition,
      'The contract holds no balance to resolve.',
    );
  }
  if (split.buyer + split.merchant !== balance) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      `buyerAmount and merchantAmount must add up to the contract's balance, ` +
        `${fromStroops(balance)} USDC (they add up to ` +
        `${fromStroops(split.buyer + split.merchant)})`,
    );
  }
  return split;
}

/** The whole balance to one party: what the auto deadline policies resolve. */
export function wholeBalanceTo(
  party: 'BUYER' | 'MERCHANT',
  balance: bigint,
): Split {
  return party === 'BUYER'
    ? { buyer: balance, merchant: 0n }
    : { buyer: 0n, merchant: balance };
}
