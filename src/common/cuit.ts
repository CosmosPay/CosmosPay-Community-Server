/**
 * Argentina's tax ids (CUIT, and the CUIL of a person, which has the same
 * shape): 11 digits whose last one is a check digit over the first ten. Pure,
 * so a spec calls it on plain strings. Shared by every plugin that takes one
 * (a bank transfer's payer, a seller's account, a P2P payer's bank account),
 * because private copies of one rule drift apart.
 */

/** The CUIT/CUIL check digit's weights, over its first ten digits. */
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** Whether 11 digits are a CUIT/CUIL whose check digit verifies (a computed 10 never does). */
export function cuitCheckDigitValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const sum = CUIT_WEIGHTS.reduce(
    (total, weight, at) => total + weight * Number(digits[at]),
    0,
  );
  const expected = 11 - (sum % 11);
  const check = expected === 11 ? 0 : expected;
  return check !== 10 && check === Number(digits[10]);
}
