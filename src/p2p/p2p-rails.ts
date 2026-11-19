import type { P2pCurrency } from '@/p2p/p2p.constants';

/**
 * The local payment rails the P2P market trades over, and how each one's
 * account details are checked. Pure: the payment-method and order services
 * call {@link validateRailDetails}, the market route publishes
 * {@link railFields}, and the spec pins every checksum.
 *
 * A new rail is ONE entry in {@link P2P_RAILS}: its currency, its fields, and
 * the function that checks and normalizes them.
 */

/** One field of a rail's details, as the market publishes it for a form. */
export interface P2pRailField {
  name: string;
  /** What the field holds, in English; forms translate it. */
  description: string;
  required: boolean;
  /** The values it takes, when it is a choice. */
  options?: readonly string[];
}

export type RailDetails = Record<string, string>;

export type RailCheck =
  { ok: true; details: RailDetails } | { ok: false; errors: string[] };

export interface P2pRail {
  currency: P2pCurrency;
  /** A neutral display name, in English. */
  name: string;
  fields: readonly P2pRailField[];
  check(details: RailDetails): RailCheck;
  /** A short, masked line for lists and notifications. */
  summary(details: RailDetails): string;
}

// --- checksums --------------------------------------------------------------

const digits = (value: string) => [...value].map(Number);

/**
 * Argentina's CBU and CVU (22 digits): two blocks, each ending in a check
 * digit. The first block (bank 3, branch 4, check 1) weighs 7,1,3,9,7,1,3; the
 * second (account 13, check 1) weighs 3,9,7,1,3,9,7,1,3,9,7,1,3. A CVU is the
 * same number for a virtual account (its first three digits are 000).
 */
export function isValidCbu(value: string): boolean {
  if (!/^\d{22}$/.test(value)) return false;
  const d = digits(value);
  const check = (block: number[], weights: number[]) => {
    const sum = weights.reduce((acc, w, i) => acc + w * block[i], 0);
    return (10 - (sum % 10)) % 10;
  };
  return (
    check(d.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === d[7] &&
    check(d.slice(8, 21), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === d[21]
  );
}

/** A CBU/CVU alias: 6 to 20 of lowercase letters, digits, dots and hyphens. */
export function isValidCbuAlias(value: string): boolean {
  return /^[a-z0-9.-]{6,20}$/.test(value);
}

/**
 * Argentina's CUIT / CUIL (11 digits): weights 5,4,3,2,7,6,5,4,3,2 over the
 * first ten, check = 11 - sum mod 11 (11 → 0; 10 never issued).
 */
export function isValidCuit(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const d = digits(value);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * d[i], 0);
  const mod = 11 - (sum % 11);
  const check = mod === 11 ? 0 : mod;
  return check !== 10 && check === d[10];
}

/** Brazil's CPF (11 digits): two mod-11 check digits; a repeated digit is never valid. */
export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const d = digits(value);
  const checkAt = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += d[i] * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkAt(9) === d[9] && checkAt(10) === d[10];
}

/** Brazil's CNPJ (14 digits): two mod-11 check digits. */
export function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const d = digits(value);
  const checkAt = (length: number) => {
    const weights =
      length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * d[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return checkAt(12) === d[12] && checkAt(13) === d[13];
}

/**
 * Mexico's CLABE (18 digits): weights 3,7,1 repeating over the first 17, each
 * product taken mod 10; check = (10 - sum mod 10) mod 10.
 */
export function isValidClabe(value: string): boolean {
  if (!/^\d{18}$/.test(value)) return false;
  const d = digits(value);
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (d[i] * weights[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === d[17];
}

/** Chile's RUT (`12345678-5`, `K` allowed): mod 11 with weights 2..7 from the right. */
export function isValidRut(value: string): boolean {
  const match = /^(\d{7,8})-?([\dK])$/i.exec(value.replace(/\./g, ''));
  if (!match) return false;
  const body = digits(match[1]).reverse();
  const sum = body.reduce((acc, digit, i) => acc + digit * (2 + (i % 6)), 0);
  const dv = 11 - (sum % 11);
  const expected = dv === 11 ? '0' : dv === 10 ? 'K' : String(dv);
  return match[2].toUpperCase() === expected;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
/** A PIX random key (EVP): a UUID, lowercase. */
const EVP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Brazilian phone as PIX keys hold it: +55, area code, 8 or 9 digits. */
const BR_PHONE_RE = /^\+55\d{10,11}$/;

const onlyDigits = (value: string) => value.replace(/[\s.\-/]/g, '');

// --- rails --------------------------------------------------------------------

function field(
  name: string,
  description: string,
  required = true,
  options?: readonly string[],
): P2pRailField {
  return options
    ? { name, description, required, options }
    : { name, description, required };
}

function mask(value: string): string {
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

/** Keeps only declared fields; a value must be a string within bounds. */
function pick(
  details: RailDetails,
  fields: readonly P2pRailField[],
): { values: RailDetails; errors: string[] } {
  const errors: string[] = [];
  const values: RailDetails = {};
  const known = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(details ?? {})) {
    if (!known.has(key))
      errors.push(`details.${key} is not a field of this rail`);
  }
  for (const f of fields) {
    const raw: unknown = details?.[f.name];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    if (typeof raw !== 'string' || raw.length > 120) {
      errors.push(
        `details.${f.name} must be a string of at most 120 characters`,
      );
      continue;
    }
    const value = raw.trim();
    if (f.options && !f.options.includes(value)) {
      errors.push(`details.${f.name} must be one of ${f.options.join(', ')}`);
      continue;
    }
    values[f.name] = value;
  }
  return { values, errors };
}

function result(values: RailDetails, errors: string[]): RailCheck {
  return errors.length ? { ok: false, errors } : { ok: true, details: values };
}

function requireFields(
  values: RailDetails,
  names: readonly string[],
  errors: string[],
): void {
  for (const name of names) {
    if (!values[name]) errors.push(`details.${name} is required`);
  }
}

const AR_FIELDS = [
  field('cbu', 'CBU or CVU, 22 digits (or give alias instead)', false),
  field(
    'alias',
    'CBU/CVU alias, 6 to 20 characters (or give cbu instead)',
    false,
  ),
  field('cuit', "The holder's CUIT or CUIL, 11 digits"),
] as const;

const BR_KEY_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'evp'] as const;
const BR_FIELDS = [
  field('keyType', 'The kind of PIX key', true, BR_KEY_TYPES),
  field('key', 'The PIX key'),
] as const;

const MX_FIELDS = [field('clabe', 'CLABE, 18 digits')] as const;

const CO_ACCOUNT_TYPES = ['savings', 'checking'] as const;
const CO_DOCUMENT_TYPES = ['CC', 'CE', 'NIT', 'PP'] as const;
const CO_FIELDS = [
  field('bank', 'Bank name'),
  field('accountType', 'Account type', true, CO_ACCOUNT_TYPES),
  field('accountNumber', 'Account number, 6 to 20 digits'),
  field('documentType', "The holder's document type", true, CO_DOCUMENT_TYPES),
  field('documentNumber', "The holder's document number"),
] as const;

const PE_DOCUMENT_TYPES = ['DNI', 'CE', 'RUC', 'PP'] as const;
const PE_FIELDS = [
  field('cci', 'CCI (interbank account code), 20 digits'),
  field('documentType', "The holder's document type", true, PE_DOCUMENT_TYPES),
  field('documentNumber', "The holder's document number"),
] as const;

const CL_ACCOUNT_TYPES = ['checking', 'vista', 'savings'] as const;
const CL_FIELDS = [
  field('bank', 'Bank name'),
  field('accountType', 'Account type', true, CL_ACCOUNT_TYPES),
  field('accountNumber', 'Account number, 4 to 20 digits'),
  field('rut', "The holder's RUT, with its check digit"),
] as const;

const DOCUMENT_NUMBER_RE = /^[A-Za-z0-9]{5,15}$/;
const BANK_NAME_RE = /^[\p{L}\p{N} .,&'-]{2,60}$/u;

export const P2P_RAIL_IDS = [
  'ar_bank_transfer',
  'br_pix',
  'mx_spei',
  'co_bank_transfer',
  'pe_bank_transfer',
  'cl_bank_transfer',
] as const;
export type P2pRailId = (typeof P2P_RAIL_IDS)[number];

export function isP2pRailId(value: unknown): value is P2pRailId {
  return (
    typeof value === 'string' &&
    (P2P_RAIL_IDS as readonly string[]).includes(value)
  );
}

export const P2P_RAILS: Record<P2pRailId, P2pRail> = {
  ar_bank_transfer: {
    currency: 'ARS',
    name: 'Bank transfer (CBU, CVU or alias)',
    fields: AR_FIELDS,
    check(details) {
      const { values, errors } = pick(details, AR_FIELDS);
      if (values.cbu) values.cbu = onlyDigits(values.cbu);
      if (values.alias) values.alias = values.alias.toLowerCase();
      if (values.cuit) values.cuit = onlyDigits(values.cuit);
      if (Boolean(values.cbu) === Boolean(values.alias)) {
        errors.push('details: give exactly one of cbu or alias');
      }
      if (values.cbu && !isValidCbu(values.cbu)) {
        errors.push(
          'details.cbu is not a valid CBU or CVU (22 digits with check digits)',
        );
      }
      if (values.alias && !isValidCbuAlias(values.alias)) {
        errors.push(
          'details.alias must be 6 to 20 of a-z, 0-9, dot and hyphen',
        );
      }
      requireFields(values, ['cuit'], errors);
      if (values.cuit && !isValidCuit(values.cuit)) {
        errors.push('details.cuit is not a valid CUIT or CUIL');
      }
      return result(values, errors);
    },
    summary: (d) => (d.alias ? `alias ${d.alias}` : `CBU ${mask(d.cbu ?? '')}`),
  },
  br_pix: {
    currency: 'BRL',
    name: 'PIX',
    fields: BR_FIELDS,
    check(details) {
      const { values, errors } = pick(details, BR_FIELDS);
      requireFields(values, ['keyType', 'key'], errors);
      const { keyType } = values;
      let key = values.key ?? '';
      if (keyType === 'cpf' || keyType === 'cnpj') key = onlyDigits(key);
      if (keyType === 'email' || keyType === 'evp') key = key.toLowerCase();
      if (keyType === 'phone') key = key.replace(/[\s()-]/g, '');
      const valid: Record<string, (k: string) => boolean> = {
        cpf: isValidCpf,
        cnpj: isValidCnpj,
        email: (k) => EMAIL_RE.test(k),
        phone: (k) => BR_PHONE_RE.test(k),
        evp: (k) => EVP_RE.test(k),
      };
      if (keyType && values.key && !valid[keyType]?.(key)) {
        errors.push(`details.key is not a valid PIX ${keyType} key`);
      }
      if (values.key) values.key = key;
      return result(values, errors);
    },
    summary: (d) =>
      `PIX ${d.keyType} ${d.keyType === 'email' ? d.key : mask(d.key ?? '')}`,
  },
  mx_spei: {
    currency: 'MXN',
    name: 'SPEI (CLABE)',
    fields: MX_FIELDS,
    check(details) {
      const { values, errors } = pick(details, MX_FIELDS);
      if (values.clabe) values.clabe = onlyDigits(values.clabe);
      requireFields(values, ['clabe'], errors);
      if (values.clabe && !isValidClabe(values.clabe)) {
        errors.push(
          'details.clabe is not a valid CLABE (18 digits with a check digit)',
        );
      }
      return result(values, errors);
    },
    summary: (d) => `CLABE ${mask(d.clabe ?? '')}`,
  },
  co_bank_transfer: {
    currency: 'COP',
    name: 'Bank transfer',
    fields: CO_FIELDS,
    check(details) {
      const { values, errors } = pick(details, CO_FIELDS);
      if (values.accountNumber)
        values.accountNumber = onlyDigits(values.accountNumber);
      requireFields(
        values,
        [
          'bank',
          'accountType',
          'accountNumber',
          'documentType',
          'documentNumber',
        ],
        errors,
      );
      if (values.bank && !BANK_NAME_RE.test(values.bank)) {
        errors.push('details.bank must be a bank name');
      }
      if (values.accountNumber && !/^\d{6,20}$/.test(values.accountNumber)) {
        errors.push('details.accountNumber must be 6 to 20 digits');
      }
      if (
        values.documentNumber &&
        !DOCUMENT_NUMBER_RE.test(values.documentNumber)
      ) {
        errors.push('details.documentNumber must be 5 to 15 letters or digits');
      }
      return result(values, errors);
    },
    summary: (d) => `${d.bank} ${mask(d.accountNumber ?? '')}`,
  },
  pe_bank_transfer: {
    currency: 'PEN',
    name: 'Bank transfer (CCI)',
    fields: PE_FIELDS,
    check(details) {
      const { values, errors } = pick(details, PE_FIELDS);
      if (values.cci) values.cci = onlyDigits(values.cci);
      requireFields(values, ['cci', 'documentType', 'documentNumber'], errors);
      if (values.cci && !/^\d{20}$/.test(values.cci)) {
        errors.push('details.cci must be 20 digits');
      }
      if (
        values.documentNumber &&
        !DOCUMENT_NUMBER_RE.test(values.documentNumber)
      ) {
        errors.push('details.documentNumber must be 5 to 15 letters or digits');
      }
      return result(values, errors);
    },
    summary: (d) => `CCI ${mask(d.cci ?? '')}`,
  },
  cl_bank_transfer: {
    currency: 'CLP',
    name: 'Bank transfer',
    fields: CL_FIELDS,
    check(details) {
      const { values, errors } = pick(details, CL_FIELDS);
      if (values.accountNumber)
        values.accountNumber = onlyDigits(values.accountNumber);
      if (values.rut) values.rut = values.rut.replace(/\./g, '').toUpperCase();
      requireFields(
        values,
        ['bank', 'accountType', 'accountNumber', 'rut'],
        errors,
      );
      if (values.bank && !BANK_NAME_RE.test(values.bank)) {
        errors.push('details.bank must be a bank name');
      }
      if (values.accountNumber && !/^\d{4,20}$/.test(values.accountNumber)) {
        errors.push('details.accountNumber must be 4 to 20 digits');
      }
      if (values.rut && !isValidRut(values.rut)) {
        errors.push('details.rut is not a valid RUT');
      }
      return result(values, errors);
    },
    summary: (d) => `${d.bank} ${mask(d.accountNumber ?? '')}`,
  },
};

/** Checks a rail's details for its currency; one message per problem. */
export function validateRailDetails(
  rail: P2pRailId,
  currency: string,
  details: unknown,
): RailCheck {
  const entry = P2P_RAILS[rail];
  if (entry.currency !== currency) {
    return {
      ok: false,
      errors: [`rail ${rail} pays in ${entry.currency}, not ${currency}`],
    };
  }
  if (
    details === null ||
    typeof details !== 'object' ||
    Array.isArray(details)
  ) {
    return { ok: false, errors: ['details must be an object'] };
  }
  return entry.check(details as RailDetails);
}

/** The rails that pay in `currency`. */
export function railsFor(currency: string): P2pRailId[] {
  return P2P_RAIL_IDS.filter((id) => P2P_RAILS[id].currency === currency);
}

/**
 * A person's name as a payer or a beneficiary gives it: letters (any script),
 * spaces and the punctuation names carry, 2 to 100 characters.
 */
export function isPersonName(value: string): boolean {
  return /^[\p{L}\p{M}][\p{L}\p{M} .,'-]{1,99}$/u.test(value.trim());
}

/** An identity document number: 4 to 20 letters, digits, dots and hyphens. */
export function isDocumentNumber(value: string): boolean {
  return /^[A-Za-z0-9.-]{4,20}$/.test(value.trim());
}
