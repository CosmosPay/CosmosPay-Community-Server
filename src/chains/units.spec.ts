import { decimalPlaces, formatUnits, parseUnits } from '@/chains/units';

describe('units', () => {
  it('parses a decimal into base units exactly, far beyond a float’s precision', () => {
    expect(parseUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseUnits('1', 18)).toBe(10n ** 18n);
    expect(parseUnits('123456789.000000000000000001', 18)).toBe(
      123456789n * 10n ** 18n + 1n,
    );
  });

  it('refuses more places than the asset has, and anything not a decimal', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow(/decimal places/);
    expect(() => parseUnits('-1', 6)).toThrow();
    expect(() => parseUnits('1e3', 6)).toThrow();
  });

  it('formats base units back without trailing zeros', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnits(10n ** 18n, 18)).toBe('1');
  });

  it('counts decimal places', () => {
    expect(decimalPlaces('1')).toBe(0);
    expect(decimalPlaces('1.250')).toBe(3);
  });
});
