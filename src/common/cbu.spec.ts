import { cbuCheckDigitsValid } from '@/common/cbu';

describe('cbuCheckDigitsValid', () => {
  it('accepts a CBU/CVU whose two check digits verify', () => {
    // Block 1: 0000003 weighs 3 * 3 = 9, check 1. Block 2: all zeros, check 0.
    expect(cbuCheckDigitsValid('0000003100000000000000')).toBe(true);
    // Block 2: ...123 weighs 3 * 3 + 2 * 1 + 1 * 7 = 18, check 2.
    expect(cbuCheckDigitsValid('0000003100000000001232')).toBe(true);
    // A bank CBU: 285 0590 9 / 4009041813520 1 (weights 7139713 and 3971397139713).
    expect(cbuCheckDigitsValid('2850590940090418135201')).toBe(true);
  });

  it('refuses a wrong check digit in either block', () => {
    expect(cbuCheckDigitsValid('0000003200000000000000')).toBe(false);
    expect(cbuCheckDigitsValid('0000003100000000001234')).toBe(false);
    expect(cbuCheckDigitsValid('2850590940090418135202')).toBe(false);
    expect(cbuCheckDigitsValid('2850590840090418135201')).toBe(false);
  });

  it('refuses anything but 22 digits', () => {
    expect(cbuCheckDigitsValid('000000310000000000000')).toBe(false);
    expect(cbuCheckDigitsValid('00000031000000000000000')).toBe(false);
    expect(cbuCheckDigitsValid('0000-0031-0000-0000-0000-00')).toBe(false);
    expect(cbuCheckDigitsValid('')).toBe(false);
  });
});
