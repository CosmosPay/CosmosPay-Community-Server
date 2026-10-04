/**
 * Recursive Length Prefix — the serialization every EVM transaction is signed
 * over. Encoding builds the relayer's transactions; decoding reads back a
 * transaction a wallet signed, so a swap's submit can check it is the one this
 * service built. An item is bytes or a list of items; numbers are their minimal
 * big-endian bytes (zero is the empty string), per the Yellow Paper.
 */
export type RlpItem = Uint8Array | RlpItem[];

function lengthPrefix(length: number, shortBase: number): Uint8Array {
  if (length < 56) return Uint8Array.of(shortBase + length);
  const lenBytes = bigintToBytes(BigInt(length));
  return Uint8Array.of(shortBase + 55 + lenBytes.length, ...lenBytes);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80), item]);
  }
  const body = concat(item.map(rlpEncode));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

/** A non-negative integer as minimal big-endian bytes; zero is empty. */
export function bigintToBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('RLP cannot encode a negative number');
  if (value === 0n) return new Uint8Array();
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** `0x`-prefixed hex (or empty `0x`) as bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.replace(/^0x/, '');
  if (body.length % 2 || /[^0-9a-fA-F]/.test(body)) {
    throw new Error(`"${hex}" is not even-length hex`);
  }
  return Uint8Array.from(Buffer.from(body, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

/**
 * Decodes one RLP item that must span `bytes` exactly. Strict: a length that
 * runs past the input, trailing bytes, or a long form used where the short
 * form fits are all refused — a signed transaction has one encoding, and
 * accepting others would let two byte strings pass as the same transaction.
 */
export function rlpDecode(bytes: Uint8Array): RlpItem {
  const [item, end] = decodeAt(bytes, 0);
  if (end !== bytes.length) throw new Error('RLP: trailing bytes');
  return item;
}

function decodeAt(bytes: Uint8Array, at: number): [RlpItem, number] {
  if (at >= bytes.length) throw new Error('RLP: unexpected end of input');
  const prefix = bytes[at];
  if (prefix < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  if (prefix < 0xb8) {
    const len = prefix - 0x80;
    const body = slice(bytes, at + 1, len);
    if (len === 1 && body[0] < 0x80) {
      throw new Error('RLP: non-canonical single byte');
    }
    return [body, at + 1 + len];
  }
  if (prefix < 0xc0) {
    const [len, start] = longLength(bytes, at, prefix - 0xb7);
    return [slice(bytes, start, len), start + len];
  }
  const [len, start] =
    prefix < 0xf8
      ? [prefix - 0xc0, at + 1]
      : longLength(bytes, at, prefix - 0xf7);
  const end = start + len;
  if (end > bytes.length) throw new Error('RLP: list runs past the input');
  const items: RlpItem[] = [];
  let cursor = start;
  while (cursor < end) {
    const [item, next] = decodeAt(bytes, cursor);
    items.push(item);
    cursor = next;
  }
  if (cursor !== end) throw new Error('RLP: list length mismatch');
  return [items, end];
}

function longLength(
  bytes: Uint8Array,
  at: number,
  lenOfLen: number,
): [number, number] {
  const lenBytes = slice(bytes, at + 1, lenOfLen);
  if (lenBytes[0] === 0) throw new Error('RLP: non-canonical length');
  const len = Number(BigInt(bytesToHex(lenBytes)));
  if (len < 56) throw new Error('RLP: non-canonical long form');
  return [len, at + 1 + lenOfLen];
}

function slice(bytes: Uint8Array, start: number, len: number): Uint8Array {
  if (start + len > bytes.length)
    throw new Error('RLP: item runs past the input');
  return bytes.subarray(start, start + len);
}
