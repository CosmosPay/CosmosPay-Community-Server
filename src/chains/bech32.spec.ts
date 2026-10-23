import { convertBits, decodeBech32 } from '@/chains/bech32';

describe('decodeBech32', () => {
  // BIP-173 "Test vectors": valid bech32 strings.
  it.each([
    'A12UEL5L',
    'a12uel5l',
    'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
    'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
    // 90 characters, the most either BIP allows.
    `11${'q'.repeat(82)}c8247j`,
    'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
    '?1ezyfcl',
  ])('decodes BIP-173 vector %s as bech32', (value) => {
    expect(decodeBech32(value)?.encoding).toBe('bech32');
  });

  // BIP-350 "Test vectors for Bech32m": valid bech32m strings.
  it.each([
    'A1LQFN3A',
    'a1lqfn3a',
    'an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6',
    'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx',
    `11${'l'.repeat(83)}udsr8`,
    'split1checkupstagehandshakeupstreamerranterredcaperredlc445v',
    '?1v759aa',
  ])('decodes BIP-350 vector %s as bech32m', (value) => {
    expect(decodeBech32(value)?.encoding).toBe('bech32m');
  });

  it('lower-cases the human-readable part and strips the checksum', () => {
    expect(decodeBech32('A12UEL5L')).toEqual({
      hrp: 'a',
      data: [],
      encoding: 'bech32',
    });
    expect(
      decodeBech32('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw'),
    ).toEqual(
      expect.objectContaining({
        hrp: 'abcdef',
        data: Array.from({ length: 32 }, (_, i) => i),
      }),
    );
  });

  // BIP-173 and BIP-350 invalid strings, each with the reason the BIP gives.
  it.each([
    ['\x201nwldj5', 'HRP character out of range'],
    ['\x7f1axkwrx', 'HRP character out of range'],
    ['\x801eym55h', 'HRP character out of range'],
    [
      'an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx',
      'overall max length exceeded',
    ],
    ['pzry9x0s0muk', 'no separator character'],
    ['1pzry9x0s0muk', 'empty HRP'],
    ['x1b4n0q5v', 'invalid data character'],
    ['li1dgmt3', 'too short checksum'],
    ['de1lg7wt\xff', 'invalid character in checksum'],
    ['A1G7SGD8', 'checksum calculated with uppercase form of HRP'],
    ['10a06t8', 'empty HRP'],
    ['1qzzfhee', 'empty HRP'],
    ['M1VUXWEZ', 'checksum calculated with uppercase form of HRP (bech32m)'],
    ['16plkw9', 'empty HRP (bech32m)'],
    ['1p2gdwpf', 'empty HRP (bech32m)'],
  ])('refuses %j (%s)', (value) => {
    expect(decodeBech32(value)).toBeNull();
  });

  it('refuses a mixed-case string', () => {
    expect(decodeBech32('A12uEL5L')).toBeNull();
  });

  it('refuses a string whose checksum is off by one character', () => {
    expect(decodeBech32('a12uel5m')).toBeNull();
  });
});

describe('convertBits', () => {
  it('round-trips bytes through 5-bit groups', () => {
    const bytes = [0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91];
    const words = convertBits(bytes, 8, 5, true)!;
    expect(convertBits(words, 5, 8, false)).toEqual(bytes);
  });

  it('refuses non-zero padding and padding of a whole group or more', () => {
    // 2 groups = 10 bits: one byte and 2 leftover bits, which must be zero.
    expect(convertBits([0, 1], 5, 8, false)).toBeNull();
    // 3 groups = 15 bits: one byte and 7 leftover bits — more than a group.
    expect(convertBits([0, 0, 0], 5, 8, false)).toBeNull();
  });

  it('refuses a value wider than its group', () => {
    expect(convertBits([32], 5, 8, true)).toBeNull();
  });
});
