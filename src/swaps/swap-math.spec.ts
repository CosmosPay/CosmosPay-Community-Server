import {
  applySlippage,
  computeFee,
  fromStroops,
  sameAmount,
  toStroops,
} from '@/swaps/swap-math';

describe('swap-math', () => {
  describe('toStroops', () => {
    it('parses integers and decimals to stroops', () => {
      expect(toStroops('1')).toBe(10_000_000n);
      expect(toStroops('100')).toBe(1_000_000_000n);
      expect(toStroops('0.5')).toBe(5_000_000n);
      expect(toStroops('99.5')).toBe(995_000_000n);
      expect(toStroops('0.0000001')).toBe(1n);
      expect(toStroops('0')).toBe(0n);
    });

    it('rejects malformed amounts', () => {
      expect(() => toStroops('')).toThrow(RangeError);
      expect(() => toStroops('1.')).toThrow(RangeError);
      expect(() => toStroops('-1')).toThrow(RangeError);
      expect(() => toStroops('1.12345678')).toThrow(RangeError); // 8 dp
      expect(() => toStroops('abc')).toThrow(RangeError);
    });

    it('rejects amounts above the int64 ceiling', () => {
      expect(() => toStroops('1000000000000')).toThrow(/maximum/);
    });
  });

  describe('fromStroops', () => {
    it('formats stroops back to trimmed decimal strings', () => {
      expect(fromStroops(10_000_000n)).toBe('1');
      expect(fromStroops(5_000_000n)).toBe('0.5');
      expect(fromStroops(995_000_000n)).toBe('99.5');
      expect(fromStroops(1n)).toBe('0.0000001');
      expect(fromStroops(0n)).toBe('0');
    });

    it('round-trips with toStroops', () => {
      for (const a of ['0', '0.0000001', '99.5', '120.1234567', '1000000']) {
        expect(fromStroops(toStroops(a))).toBe(a);
      }
    });
  });

  describe('sameAmount', () => {
    it('compares by value, not by spelling', () => {
      expect(sameAmount('10', '10.0000000')).toBe(true);
      expect(sameAmount('0.5', '0.50')).toBe(true);
      expect(sameAmount('10', '10.0000001')).toBe(false);
    });

    it('is false rather than throwing when either side is not an amount', () => {
      expect(sameAmount('abc', '1')).toBe(false);
      expect(sameAmount('1', '1.12345678')).toBe(false);
      expect(sameAmount('1000000000000', '1000000000000')).toBe(false);
    });
  });

  describe('computeFee', () => {
    it('computes a basis-point fee, rounded down', () => {
      // 0.5% of 100 XLM = 0.5 XLM
      expect(fromStroops(computeFee(toStroops('100'), 50))).toBe('0.5');
      // 1% of 250 = 2.5
      expect(fromStroops(computeFee(toStroops('250'), 100))).toBe('2.5');
      // 0 bps → no fee
      expect(computeFee(toStroops('100'), 0)).toBe(0n);
      // rounds down (never over-charges): 0.3% of 0.0000001 = 0
      expect(computeFee(toStroops('0.0000001'), 30)).toBe(0n);
    });

    it('rejects out-of-range bps', () => {
      expect(() => computeFee(1n, -1)).toThrow(RangeError);
      expect(() => computeFee(1n, 10_001)).toThrow(RangeError);
    });
  });

  describe('applySlippage', () => {
    it('reduces the estimate by the slippage tolerance', () => {
      // 0.5% slippage on 24.81 → 24.685950 → trimmed
      expect(fromStroops(applySlippage(toStroops('24.81'), 50))).toBe(
        '24.68595',
      );
      // 0 slippage → unchanged
      expect(fromStroops(applySlippage(toStroops('24.81'), 0))).toBe('24.81');
    });

    it('rejects out-of-range bps', () => {
      expect(() => applySlippage(1n, -1)).toThrow(RangeError);
      expect(() => applySlippage(1n, 10_001)).toThrow(RangeError);
    });
  });
});
