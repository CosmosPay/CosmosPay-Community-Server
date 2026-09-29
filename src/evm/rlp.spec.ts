import { bigintToBytes, bytesToHex, rlpEncode } from '@/evm/rlp';

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
