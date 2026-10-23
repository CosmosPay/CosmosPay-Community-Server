/**
 * BIP-173 bech32 and BIP-350 bech32m: the string encodings of Bitcoin's segwit
 * addresses. Decoding only — this service reads addresses, it never mints one.
 *
 * The two encodings differ in one constant, XOR-ed into the checksum, and
 * BIP-350 makes it part of the address's meaning: witness version 0 must use
 * bech32, every later version bech32m. So decoding reports which one a string
 * carries rather than accepting either, and the segwit rule in
 * `bitcoin-address.ts` checks it against the version.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** The BCH code's generator, from the BIP's reference implementation. */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** What the checksum polymod must come out as, per encoding. */
const CHECKSUM_CONSTANTS = {
  bech32: 1,
  bech32m: 0x2bc830a3,
} as const;

/** The longest string either BIP admits, separator and checksum included. */
const MAX_LENGTH = 90;

const CHECKSUM_LENGTH = 6;

export type Bech32Encoding = keyof typeof CHECKSUM_CONSTANTS;

export interface Bech32Decoded {
  /** The human-readable part, lowercase (`bc` for a mainnet address). */
  hrp: string;
  /** The 5-bit groups between the separator and the checksum. */
  data: number[];
  encoding: Bech32Encoding;
}

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < GENERATOR.length; i += 1) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function expandHrp(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    const code = char.charCodeAt(0);
    high.push(code >> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/**
 * Decodes a bech32 or bech32m string, checksum verified. Null for anything
 * either BIP refuses: a character outside 33–126, mixed case, no separator, an
 * empty human-readable part, a data character outside the charset, a checksum
 * shorter than six characters or matching neither constant, or more than 90
 * characters in all.
 */
export function decodeBech32(value: string): Bech32Decoded | null {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return null;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 33 || code > 126) return null;
  }
  const lower = value.toLowerCase();
  // An address is all one case: upper case is legal (it packs tighter into a
  // QR code), a mix of the two is not.
  if (value !== lower && value !== value.toUpperCase()) return null;

  const separator = lower.lastIndexOf('1');
  if (separator < 1 || separator + CHECKSUM_LENGTH + 1 > lower.length) {
    return null;
  }
  const hrp = lower.slice(0, separator);
  const data: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const index = CHARSET.indexOf(char);
    if (index < 0) return null;
    data.push(index);
  }

  const check = polymod([...expandHrp(hrp), ...data]);
  const encoding = (Object.keys(CHECKSUM_CONSTANTS) as Bech32Encoding[]).find(
    (name) => CHECKSUM_CONSTANTS[name] === check,
  );
  if (!encoding) return null;
  return { hrp, data: data.slice(0, -CHECKSUM_LENGTH), encoding };
}

/**
 * Regroups bits — 5-bit bech32 groups into bytes, here. Without `pad`, the
 * leftover bits must be fewer than `from` and all zero, as BIP-173 requires of
 * a witness program; anything else is null rather than a silently different
 * program.
 */
export function convertBits(
  data: number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << to) - 1;
  const maxAcc = (1 << (from + to - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = ((acc << from) | value) & maxAcc;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxValue);
  } else if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) {
    return null;
  }
  return out;
}
