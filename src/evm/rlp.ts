/**
 * Recursive Length Prefix encoding — the serialization every EVM transaction
 * is signed over. Only encoding: this service builds transactions, it never
 * parses them. An item is bytes or a list of items; numbers are encoded as
 * their minimal big-endian bytes (zero is the empty string), per the Yellow
 * Paper.
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
