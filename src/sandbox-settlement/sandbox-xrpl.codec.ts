import { ed25519 } from '@noble/curves/ed25519.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import {
  XRPL_FIELDS,
  XRPL_TX_TYPES,
} from '@/sandbox-settlement/sandbox-xrpl.constants';

/**
 * The slice of the XRP Ledger's binary format the sandbox needs: classic
 * addresses, issued-currency and XRP amounts, and the Payment and TrustSet
 * transactions its treasury signs with an ed25519 key. Pure; pinned in the
 * spec to vectors from `ripple-binary-codec` / `ripple-keypairs`.
 */

const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const ACCOUNT_VERSION = 0x00;
/** `STX\0`: the prefix of the bytes a single signature covers. */
const SIGN_PREFIX = Uint8Array.from([0x53, 0x54, 0x58, 0x00]);
/** `TXN\0`: the prefix of the bytes a transaction id hashes. */
const TX_ID_PREFIX = Uint8Array.from([0x54, 0x58, 0x4e, 0x00]);
/** An ed25519 public key on the XRP Ledger is 0xED + its 32 bytes. */
const ED25519_KEY_PREFIX = 0xed;

const MIN_MANTISSA = 10n ** 15n;
const MAX_MANTISSA = 10n ** 16n - 1n;
const MIN_EXPONENT = -96;
const MAX_EXPONENT = 80;
/** Bit 63: not XRP. Bit 62: positive. */
const IOU_FLAG = 1n << 63n;
const POSITIVE_FLAG = 1n << 62n;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const toHex = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('hex').toUpperCase();

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Not hex');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).subarray(0, 4);
}

function base58Encode(bytes: Uint8Array): string {
  let value = BigInt('0x' + (toHex(bytes) || '0'));
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = ALPHABET[0] + out;
  }
  return out;
}

function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('Not an XRP Ledger base58 string');
    value = value * 58n + BigInt(digit);
  }
  let hex = value === 0n ? '' : value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === ALPHABET[0]) zeros++;
  return concat(new Uint8Array(zeros), fromHex(hex));
}

/** The classic address (`r...`) of a 20-byte account id. */
export function xrplAddressOfAccountId(accountId: Uint8Array): string {
  if (accountId.length !== 20) throw new Error('An account id is 20 bytes');
  const payload = concat(Uint8Array.of(ACCOUNT_VERSION), accountId);
  return base58Encode(concat(payload, checksum(payload)));
}

/** The 20-byte account id of a classic address; throws on a bad checksum. */
export function xrplAccountIdOf(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes.length !== 25 || bytes[0] !== ACCOUNT_VERSION) {
    throw new Error(`Not an XRP Ledger classic address: ${address}`);
  }
  const payload = bytes.subarray(0, 21);
  const sum = checksum(payload);
  if (sum.some((b, i) => b !== bytes[21 + i])) {
    throw new Error(`Bad checksum in XRP Ledger address ${address}`);
  }
  return Uint8Array.from(payload.subarray(1));
}

/** The 33-byte signing public key (0xED + ed25519 key) of an ed25519 secret. */
export function xrplPublicKey(secret: Uint8Array): Uint8Array {
  return concat(
    Uint8Array.of(ED25519_KEY_PREFIX),
    ed25519.getPublicKey(secret),
  );
}

/** The classic address of an ed25519 secret: RIPEMD160(SHA256(0xED || key)). */
export function xrplAddressOfSecret(secret: Uint8Array): string {
  return xrplAddressOfAccountId(ripemd160(sha256(xrplPublicKey(secret))));
}

/**
 * An issued-currency value as the ledger writes it (`"25.5"`, `"1e-7"`,
 * `"9999999999999990e5"`), in base units of `decimals`, truncated toward
 * zero: a fraction of a base unit is never counted as received.
 */
export function iouValueToUnits(value: string, decimals: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Not an issued-currency value: ${value}`);
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + decimals;
  const units =
    shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return sign === '-' ? -units : units;
}

/** An issued currency: 40-hex code and issuer address. */
export interface XrplCurrency {
  currency: string;
  issuer: string;
}

/** `units` base units (of `decimals`) of an issued currency, as an Amount field. */
export interface XrplIouAmount extends XrplCurrency {
  units: bigint;
  decimals: number;
}

function uint64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

function uint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Not a UInt32: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function uint16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

/** An issued-currency Amount: 8 bytes of value, the currency, the issuer. */
export function encodeIouAmount(amount: XrplIouAmount): Uint8Array {
  if (amount.units < 0n) throw new Error('A negative amount is never sent');
  let value = IOU_FLAG;
  if (amount.units > 0n) {
    let mantissa = amount.units;
    let exponent = -amount.decimals;
    while (mantissa < MIN_MANTISSA) {
      mantissa *= 10n;
      exponent -= 1;
    }
    while (mantissa > MAX_MANTISSA) {
      if (mantissa % 10n !== 0n) {
        throw new Error('An issued amount carries at most 16 digits');
      }
      mantissa /= 10n;
      exponent += 1;
    }
    if (exponent < MIN_EXPONENT || exponent > MAX_EXPONENT) {
      throw new Error('Issued amount out of range');
    }
    value |= POSITIVE_FLAG | (BigInt(exponent + 97) << 54n) | mantissa;
  }
  const currency = fromHex(amount.currency);
  if (currency.length !== 20) throw new Error('A currency code is 20 bytes');
  return concat(uint64(value), currency, xrplAccountIdOf(amount.issuer));
}

/** An XRP Amount in drops (the fee). */
export function encodeDrops(drops: bigint): Uint8Array {
  if (drops < 0n || drops >= POSITIVE_FLAG) throw new Error('Bad XRP amount');
  return uint64(POSITIVE_FLAG | drops);
}

/** The transactions the treasury signs, with every field it writes. */
export interface XrplTransaction {
  TransactionType: keyof typeof XRPL_TX_TYPES;
  Flags: number;
  Sequence: number;
  LastLedgerSequence: number;
  /** Drops. */
  Fee: bigint;
  Account: string;
  Destination?: string;
  DestinationTag?: number;
  Amount?: XrplIouAmount;
  LimitAmount?: XrplIouAmount;
}

type FieldName = keyof typeof XRPL_FIELDS;

function fieldHeader(name: FieldName): Uint8Array {
  const [type, field] = XRPL_FIELDS[name];
  if (type < 16 && field < 16) return Uint8Array.of((type << 4) | field);
  if (type < 16) return Uint8Array.of(type << 4, field);
  if (field < 16) return Uint8Array.of(field, type);
  return Uint8Array.of(0, type, field);
}

/** A variable-length field's length prefix (the sandbox's never pass 192 bytes). */
function withLength(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 192) throw new Error('Variable-length field too long');
  return concat(Uint8Array.of(bytes.length), bytes);
}

function serialize(fields: [FieldName, Uint8Array][]): Uint8Array {
  const order = (name: FieldName) => {
    const [type, field] = XRPL_FIELDS[name];
    return type * 256 + field;
  };
  return concat(
    ...[...fields]
      .sort(([a], [b]) => order(a) - order(b))
      .flatMap(([name, bytes]) => [fieldHeader(name), bytes]),
  );
}

function fieldsOf(
  tx: XrplTransaction,
  signingPubKey: Uint8Array,
): [FieldName, Uint8Array][] {
  const fields: [FieldName, Uint8Array][] = [
    ['TransactionType', uint16(XRPL_TX_TYPES[tx.TransactionType])],
    ['Flags', uint32(tx.Flags)],
    ['Sequence', uint32(tx.Sequence)],
    ['LastLedgerSequence', uint32(tx.LastLedgerSequence)],
    ['Fee', encodeDrops(tx.Fee)],
    ['SigningPubKey', withLength(signingPubKey)],
    ['Account', withLength(xrplAccountIdOf(tx.Account))],
  ];
  if (tx.Destination !== undefined) {
    fields.push(['Destination', withLength(xrplAccountIdOf(tx.Destination))]);
  }
  if (tx.DestinationTag !== undefined) {
    fields.push(['DestinationTag', uint32(tx.DestinationTag)]);
  }
  if (tx.Amount) fields.push(['Amount', encodeIouAmount(tx.Amount)]);
  if (tx.LimitAmount) {
    fields.push(['LimitAmount', encodeIouAmount(tx.LimitAmount)]);
  }
  return fields;
}

/** SHA-512Half: the first 32 bytes of SHA-512, the ledger's hash. */
function sha512Half(bytes: Uint8Array): Uint8Array {
  return sha512(bytes).subarray(0, 32);
}

/**
 * Signs `tx` with an ed25519 secret: the signature covers `STX\0` and the
 * canonical serialization without `TxnSignature`; the id is SHA-512Half of
 * `TXN\0` and the signed blob. Both in the ledger's uppercase hex.
 */
export function signXrplTransaction(
  tx: XrplTransaction,
  secret: Uint8Array,
): { blob: string; hash: string } {
  const publicKey = xrplPublicKey(secret);
  const fields = fieldsOf(tx, publicKey);
  const signature = ed25519.sign(
    concat(SIGN_PREFIX, serialize(fields)),
    secret,
  );
  const blob = serialize([...fields, ['TxnSignature', withLength(signature)]]);
  return {
    blob: toHex(blob),
    hash: toHex(sha512Half(concat(TX_ID_PREFIX, blob))),
  };
}

/**
 * The `LastLedgerSequence` of a blob {@link signXrplTransaction} wrote; null
 * when it carries none or is not one of them. Walks the fields the sandbox
 * writes (UInt16, UInt32, Amount, variable length).
 */
export function xrplLastLedgerSequence(blobHex: string): number | null {
  let bytes: Uint8Array;
  try {
    bytes = fromHex(blobHex);
  } catch {
    return null;
  }
  let at = 0;
  while (at < bytes.length) {
    let type = bytes[at] >> 4;
    let field = bytes[at] & 0x0f;
    at += 1;
    if (type === 0) type = bytes[at++];
    if (field === 0) field = bytes[at++];
    let size: number;
    if (type === 1) size = 2;
    else if (type === 2) size = 4;
    else if (type === 6) size = bytes[at] & 0x80 ? 48 : 8;
    else if (type === 7 || type === 8) size = 1 + bytes[at];
    else return null;
    if (type === 2 && field === XRPL_FIELDS.LastLedgerSequence[1]) {
      return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(
        0,
        false,
      );
    }
    at += size;
  }
  return null;
}
