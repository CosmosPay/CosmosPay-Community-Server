import { toStroops } from '../swaps/swap-math';
import { matchDeposit, priceBounds, proportionalShare } from './lp-math';

describe('priceBounds', () => {
  it('brackets the reserves ratio by the slippage tolerance', () => {
    // 1000 XLM / 100 USDC → price 10, ±1% → [9.9, 10.1]
    const { minPrice, maxPrice } = priceBounds(
      toStroops('1000'),
      toStroops('100'),
      100,
    );
    expect(minPrice).toBe('9.9');
    expect(maxPrice).toBe('10.1');
  });

  it('never narrows the window on rounding', () => {
    const { minPrice, maxPrice } = priceBounds(
      toStroops('1'),
      toStroops('3'),
      1,
    );
    // price ≈ 0.3333333; min floors, max ceils
    expect(parseFloat(minPrice)).toBeLessThan(1 / 3);
    expect(parseFloat(maxPrice)).toBeGreaterThan(1 / 3);
  });

  it('rejects a price too small for 7 decimals', () => {
    expect(() => priceBounds(1n, toStroops('10000000000'), 0)).toThrow(
      RangeError,
    );
  });

  it('rejects empty reserves and bad slippage', () => {
    expect(() => priceBounds(0n, 1n, 0)).toThrow(RangeError);
    expect(() => priceBounds(1n, 1n, 10_001)).toThrow(RangeError);
  });
});

describe('matchDeposit', () => {
  it('derives the B amount from the reserves ratio', () => {
    // reserves 1000:100 → depositing 50 A takes 5 B
    expect(
      matchDeposit(toStroops('50'), toStroops('1000'), toStroops('100')),
    ).toBe(toStroops('5'));
  });

  it('floors the result', () => {
    expect(matchDeposit(1n, 3n, 1n)).toBe(0n);
  });
});

describe('proportionalShare', () => {
  it('computes the proportional claim on a reserve', () => {
    // 10% of the shares → 10% of the reserve
    expect(
      proportionalShare(toStroops('10'), toStroops('100'), toStroops('5000')),
    ).toBe(toStroops('500'));
  });

  it('rejects shares above total and an empty pool', () => {
    expect(() => proportionalShare(2n, 1n, 1n)).toThrow(RangeError);
    expect(() => proportionalShare(1n, 0n, 1n)).toThrow(RangeError);
  });
});
