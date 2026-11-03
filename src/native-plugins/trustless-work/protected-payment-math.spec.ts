import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  apiAmount,
  apiPlatformFee,
  balanceStroops,
  checkedSplit,
  distributionNet,
  feeSplit,
  totalFeeBps,
  wholeBalanceTo,
} from '@/native-plugins/trustless-work/protected-payment-math';

describe('feeSplit', () => {
  it('takes 0.30% for Trustless Work and 1.65% for Cosmos Pay, rounding each down', () => {
    // The README's worked example: 100 USDC.
    expect(feeSplit(1_000_000_000n, 165)).toEqual({
      trustlessWork: 3_000_000n, // 0.3 USDC
      platform: 16_500_000n, // 1.65 USDC
      net: 980_500_000n, // 98.05 USDC
    });
    // 125.5 USDC: 0.3765 + 2.07075 in fees.
    expect(feeSplit(1_255_000_000n, 165)).toEqual({
      trustlessWork: 3_765_000n,
      platform: 20_707_500n,
      net: 1_230_527_500n,
    });
    expect(totalFeeBps(165)).toBe(195);
  });

  it('rounds the fees down on amounts too small to carry them', () => {
    expect(feeSplit(33n, 165)).toEqual({
      trustlessWork: 0n,
      platform: 0n,
      net: 33n,
    });
  });
});

describe('distributionNet', () => {
  it('gives a refund to the buyer net of the same 1.95%', () => {
    expect(distributionNet(1_000_000_000n, 1_000_000_000n, 165)).toBe(
      980_500_000n,
    );
  });

  it('shares the fees between two distributions in proportion', () => {
    const total = 1_000_000_000n;
    expect(distributionNet(600_000_000n, total, 165)).toBe(588_300_000n);
    expect(distributionNet(400_000_000n, total, 165)).toBe(392_200_000n);
  });
});

describe('what the Trustless Work API takes', () => {
  it('sends amounts as token units and the fee as a percent', () => {
    expect(apiAmount(1_255_000_000n)).toBe(125.5);
    expect(apiAmount(1n)).toBe(0.0000001);
    expect(apiPlatformFee(165)).toBe(1.65);
  });

  it('reads a balance given as a number or as a string, and nothing else', () => {
    expect(balanceStroops(125.5)).toBe(1_255_000_000n);
    expect(balanceStroops('125.5')).toBe(1_255_000_000n);
    expect(balanceStroops(0)).toBe(0n);
    expect(balanceStroops(undefined)).toBeNull();
    expect(balanceStroops(-1)).toBeNull();
    expect(balanceStroops('abc')).toBeNull();
  });
});

describe('checkedSplit', () => {
  const refusal = (fn: () => unknown): ApiError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('accepts a split that adds up to the balance', () => {
    expect(checkedSplit({ buyer: 3n, merchant: 7n }, 10n)).toEqual({
      buyer: 3n,
      merchant: 7n,
    });
  });

  it('refuses one that does not, a negative part and an empty contract', () => {
    expect(
      refusal(() => checkedSplit({ buyer: 3n, merchant: 6n }, 10n)).code,
    ).toBe(ApiErrorCode.InvalidAmount);
    expect(
      refusal(() => checkedSplit({ buyer: -1n, merchant: 11n }, 10n)).code,
    ).toBe(ApiErrorCode.InvalidAmount);
    expect(
      refusal(() => checkedSplit({ buyer: 0n, merchant: 0n }, 0n)).code,
    ).toBe(ApiErrorCode.InvalidStateTransition);
  });

  it('gives the whole balance to one party for the auto policies', () => {
    expect(wholeBalanceTo('BUYER', 10n)).toEqual({ buyer: 10n, merchant: 0n });
    expect(wholeBalanceTo('MERCHANT', 10n)).toEqual({
      buyer: 0n,
      merchant: 10n,
    });
  });
});
