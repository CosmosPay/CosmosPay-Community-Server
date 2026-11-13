/**
 * Argentina's bank account keys, the CBU and its virtual twin the CVU: 22
 * digits in two blocks (8 and 14), each ending in the check digit of the
 * digits before it, weighted 3, 1, 7, 9 repeating from the last of them. Pure,
 * so a spec calls it on plain strings. The same rule as the developer
 * platform's `cvuOk`, so the page and this service refuse the same typos.
 */

/** The weights of a block's digits, from the one before its check digit backwards. */
const CBU_WEIGHTS = [3, 1, 7, 9] as const;

/** Whether a block's last digit is the check digit of the digits before it. */
function blockValid(block: string): boolean {
  const body = block.slice(0, -1);
  let sum = 0;
  for (let at = 0; at < body.length; at++) {
    sum += Number(body[body.length - 1 - at]) * CBU_WEIGHTS[at % 4];
  }
  return (10 - (sum % 10)) % 10 === Number(block[block.length - 1]);
}

/** Whether 22 digits are a CBU/CVU whose two check digits verify. */
export function cbuCheckDigitsValid(digits: string): boolean {
  if (!/^\d{22}$/.test(digits)) return false;
  return blockValid(digits.slice(0, 8)) && blockValid(digits.slice(8));
}
