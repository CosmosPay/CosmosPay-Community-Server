import { formatNumericAmount, toCount } from '@/common/money';

describe('formatNumericAmount', () => {
  it('keeps exactness on a value float64 cannot represent', () => {
    // 9007199254740993 is 2^53 + 1: Number() collapses it onto 2^53, so any
    // implementation that round-trips through a float returns the wrong total.
    const exact = '9007199254740993.0000001';
    expect(formatNumericAmount(exact)).toBe('9007199254740993.0000001');
    expect(String(Number(exact))).not.toBe('9007199254740993.0000001');
  });

  it('trims to Stellar precision and drops trailing zeros', () => {
    expect(formatNumericAmount('12.5000000')).toBe('12.5');
    expect(formatNumericAmount('12.0000000')).toBe('12');
    expect(formatNumericAmount('0.0000001')).toBe('0.0000001');
    // An eighth decimal is beyond Stellar's precision and is cut, not rounded.
    expect(formatNumericAmount('1.23456789')).toBe('1.2345678');
  });

  it('treats a NULL sum as zero', () => {
    // SUM over no matching rows is NULL — "nothing settled yet", not an error.
    expect(formatNumericAmount(null)).toBe('0');
    expect(formatNumericAmount(undefined)).toBe('0');
  });

  it('accepts the shapes a driver actually returns', () => {
    expect(formatNumericAmount(42)).toBe('42');
    expect(formatNumericAmount(9n)).toBe('9');
    // Decimal.js / pg-numeric wrappers define their own toString.
    expect(formatNumericAmount({ toString: () => '7.7500000' })).toBe('7.75');
  });

  it('refuses to stringify a plain object instead of emitting [object Object]', () => {
    // The bug this module exists to prevent: String({}) is '[object Object]',
    // which would silently become a customer-facing amount.
    expect(formatNumericAmount({})).toBe('0');
    expect(formatNumericAmount({ amount: 5 })).toBe('0');
    expect(formatNumericAmount([])).toBe('0');
  });

  it('rejects anything that is not a decimal number', () => {
    expect(formatNumericAmount('NaN')).toBe('0');
    expect(formatNumericAmount('12.5abc')).toBe('0');
    expect(formatNumericAmount('')).toBe('0');
    expect(formatNumericAmount(true)).toBe('0');
  });

  it('handles negatives without ever rendering -0', () => {
    expect(formatNumericAmount('-3.2500000')).toBe('-3.25');
    expect(formatNumericAmount('-0.0000000')).toBe('0');
  });
});

describe('toCount', () => {
  it('accepts the bigint COUNT(*) returns, and its string form', () => {
    expect(toCount(7n)).toBe(7);
    expect(toCount('7')).toBe(7);
    expect(toCount(7)).toBe(7);
  });

  it('is zero for absent or unusable values', () => {
    expect(toCount(null)).toBe(0);
    expect(toCount(undefined)).toBe(0);
    expect(toCount('not a number')).toBe(0);
  });
});
