import { createHmac } from 'node:crypto';

/**
 * The payer's document (an Argentine CUIT/CUIL or DNI): what identifies their
 * transfer, since the rail accepts deposits only from an account in the
 * depositor's own name. Pure, so a spec calls it on plain strings. The full
 * document is never stored or logged: only its HMAC and three digits.
 */

/** Separators a person types between digits: dashes, dots and spaces. */
const SEPARATORS_RE = /[-.\s]/g;

/** The CUIT/CUIL check digit's weights, over its first ten digits. */
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** A document once read: the DNI part that identifies the person, and the hint shown back. */
export interface PayerDocument {
  /** `cuit` (11 digits, check digit verified) or `dni` (7 or 8 digits). */
  kind: 'cuit' | 'dni';
  /** The DNI: a CUIT's digits 3 to 10, or the DNI itself, without leading zeros. */
  dniPart: string;
  /** The last three digits as typed. */
  hint: string;
}

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

/** The DNI a CUIT/CUIL or a DNI's digits carry, without leading zeros; null when none is left. */
function dniPartOf(digits: string): string | null {
  const part = (digits.length === 11 ? digits.slice(2, 10) : digits).replace(
    /^0+/,
    '',
  );
  return part === '' ? null : part;
}

/**
 * What a payer typed, read strictly: digits with or without dashes, dots or
 * spaces, either a CUIT/CUIL (11 digits whose check digit verifies) or a DNI
 * (7 or 8 digits). Null for anything else.
 */
export function parsePayerDocument(input: string): PayerDocument | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(SEPARATORS_RE, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 11) {
    if (!cuitCheckDigitValid(digits)) return null;
  } else if (digits.length !== 7 && digits.length !== 8) {
    return null;
  }
  const dniPart = dniPartOf(digits);
  if (!dniPart) return null;
  return {
    kind: digits.length === 11 ? 'cuit' : 'dni',
    dniPart,
    hint: digits.slice(-3),
  };
}

/**
 * A depositor's document as the provider reports it, read leniently: the bank
 * said it, so a check digit is not second-guessed. Any of the same shapes, a
 * number included; null when it is not one.
 */
export function readDepositorDocument(raw: unknown): PayerDocument | null {
  const text =
    typeof raw === 'number' && Number.isSafeInteger(raw)
      ? String(raw)
      : typeof raw === 'string'
        ? raw
        : '';
  const digits = text.replace(SEPARATORS_RE, '');
  if (!/^\d+$/.test(digits)) return null;
  if (![7, 8, 11].includes(digits.length)) return null;
  const dniPart = dniPartOf(digits);
  if (!dniPart) return null;
  return {
    kind: digits.length === 11 ? 'cuit' : 'dni',
    dniPart,
    hint: digits.slice(-3),
  };
}

/** What a document is stored as: hex HMAC-SHA256 of its DNI part under the deployment's pepper. */
export function documentHash(pepper: string, dniPart: string): string {
  return createHmac('sha256', pepper).update(dniPart).digest('hex');
}

/** How the hint is shown back: an ellipsis, then the three digits. */
export function documentHintLabel(hint: string): string {
  return `…${hint}`;
}
