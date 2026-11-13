import { cuitCheckDigitValid } from '@/common/cuit';

describe('cuitCheckDigitValid', () => {
  it('verifies a CUIT/CUIL check digit, and never accepts a computed 10', () => {
    expect(cuitCheckDigitValid('20123456786')).toBe(true);
    expect(cuitCheckDigitValid('27123456780')).toBe(true);
    expect(cuitCheckDigitValid('27123456781')).toBe(false);
    expect(cuitCheckDigitValid('20123456785')).toBe(false);
    expect(cuitCheckDigitValid('30712345671')).toBe(true);
    // Weighted sum 144, 144 mod 11 = 1, so 11 - 1 = 10: no digit is valid.
    for (const digit of '0123456789') {
      expect(cuitCheckDigitValid(`2012345676${digit}`)).toBe(false);
    }
  });

  it('refuses anything but 11 digits', () => {
    expect(cuitCheckDigitValid('2012345678')).toBe(false);
    expect(cuitCheckDigitValid('2012345678x')).toBe(false);
    expect(cuitCheckDigitValid('20-12345678-6')).toBe(false);
    expect(cuitCheckDigitValid('201234567860')).toBe(false);
  });
});
