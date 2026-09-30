import {
  bigintToBytes,
  bytesToHex,
  hexToBytes,
  rlpDecode,
  rlpEncode,
} from '@/evm/rlp';

const text = (s: string) => Uint8Array.from(Buffer.from(s));

describe('rlpEncode', () => {
  // The vectors from the Ethereum wiki's RLP page.
  it.each<[string, Parameters<typeof rlpEncode>[0], string]>([
    ['"dog"', text('dog'), '0x83646f67'],
    ['["cat","dog"]', [text('cat'), text('dog')], '0xc88363617483646f67'],
    ['the empty string', new Uint8Array(), '0x80'],
    ['the empty list', [], '0xc0'],
    ['0', bigintToBytes(0n), '0x80'],
    ['15', bigintToBytes(15n), '0x0f'],
    ['1024', bigintToBytes(1024n), '0x820400'],
    [
      'the set theoretical representation of three',
      [[], [[]], [[], [[]]]],
      '0xc7c0c1c0c3c0c1c0',
    ],
  ])('encodes %s', (_label, item, expected) => {
    expect(bytesToHex(rlpEncode(item))).toBe(expected);
  });

  it('uses the long form past 55 bytes', () => {
    const long = text(
      'Lorem ipsum dolor sit amet, consectetur adipisicing elit',
    );
    const encoded = rlpEncode(long);
    expect(encoded[0]).toBe(0xb8);
    expect(encoded[1]).toBe(56);
  });
});

describe('rlpDecode', () => {
  it('reads back what rlpEncode wrote, nested lists and long strings included', () => {
    const item = [
      bigintToBytes(0n),
      bigintToBytes(1024n),
      new Uint8Array(60).fill(0xab),
      [Uint8Array.of(0x7f), [new Uint8Array()]],
    ];
    expect(rlpDecode(rlpEncode(item))).toEqual(item);
  });

  it('refuses trailing bytes, a truncated item and a non-canonical encoding', () => {
    expect(() => rlpDecode(hexToBytes('0x8201'))).toThrow();
    expect(() => rlpDecode(hexToBytes('0x0102'))).toThrow('trailing');
    // 0x05 written in the long form: two spellings of one value.
    expect(() => rlpDecode(hexToBytes('0x8105'))).toThrow('non-canonical');
    expect(bytesToHex(rlpDecode(hexToBytes('0x05')) as Uint8Array)).toBe(
      '0x05',
    );
  });
});
