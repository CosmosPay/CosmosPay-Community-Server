import { decodeBech32 } from '@/chains/bech32';
import {
  bitcoinAddressKind,
  isBitcoinAddress,
  normalizeBitcoinAddress,
} from '@/chains/bitcoin-address';

const GENESIS_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const TAPROOT =
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';

describe('bitcoinAddressKind', () => {
  // BIP-173 "Examples" and the mainnet entries of BIP-350's valid list.
  it.each([
    ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'p2wpkh'],
    ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'p2wsh'],
    [TAPROOT, 'p2tr'],
  ])('accepts segwit %s as %s', (address, kind) => {
    expect(bitcoinAddressKind(address)).toBe(kind);
  });

  it.each([
    [GENESIS_P2PKH, 'p2pkh'],
    ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'p2pkh'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'p2sh'],
  ])('accepts base58check %s as %s', (address, kind) => {
    expect(bitcoinAddressKind(address)).toBe(kind);
  });

  // BIP-350's valid list, entries this service refuses on purpose. Each one
  // decodes — the refusal is policy, not a broken vector.
  it.each([
    [
      'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
      'segwit v1 with a 40-byte program: not taproot',
    ],
    ['BC1SW50QGDZ25J', 'segwit v16: no soft fork defines it'],
    [
      'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
      'segwit v2: no soft fork defines it',
    ],
    [
      'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
      'testnet',
    ],
    [
      'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
      'testnet',
    ],
  ])('refuses %s (%s)', (address) => {
    expect(decodeBech32(address)).not.toBeNull();
    expect(bitcoinAddressKind(address)).toBeNull();
  });

  // BIP-350's invalid list, each with the reason the BIP gives.
  it.each([
    [
      'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut',
      'invalid human-readable part',
    ],
    [
      'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
      'invalid checksum (bech32 instead of bech32m)',
    ],
    [
      'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL',
      'invalid checksum (bech32 instead of bech32m)',
    ],
    [
      'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47',
      'invalid checksum (bech32m instead of bech32)',
    ],
    [
      'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
      'invalid character in checksum',
    ],
    [
      'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R',
      'invalid witness version',
    ],
    ['bc1pw5dgrnzv', 'invalid program length (1 byte)'],
    [
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav',
      'invalid program length (41 bytes)',
    ],
    [
      'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P',
      'invalid program length for witness version 0',
    ],
    [
      'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq',
      'mixed case',
    ],
    [
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf',
      'zero padding of more than 4 bits',
    ],
    [
      'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j',
      'non-zero padding in 8-to-5 conversion',
    ],
    ['bc1gmk9yu', 'empty data section'],
  ])('refuses BIP-350 invalid %s (%s)', (address) => {
    expect(bitcoinAddressKind(address)).toBeNull();
  });

  it('refuses a taproot address written with the bech32 checksum', () => {
    // BIP-350's own example of the mistake BIP-350 exists to catch: the string
    // is good bech32, and that is exactly what makes it a bad v1 address.
    const v1WithBech32 =
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd';
    expect(decodeBech32(v1WithBech32)?.encoding).toBe('bech32');
    expect(bitcoinAddressKind(v1WithBech32)).toBeNull();
  });

  it('refuses a v0 address written with the bech32m checksum', () => {
    const v0WithBech32m = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh';
    expect(decodeBech32(v0WithBech32m)?.encoding).toBe('bech32m');
    expect(bitcoinAddressKind(v0WithBech32m)).toBeNull();
  });

  it('refuses a base58 address whose checksum does not verify', () => {
    const tampered = `${GENESIS_P2PKH.slice(0, -1)}b`;
    expect(bitcoinAddressKind(tampered)).toBeNull();
    // One character changed in the middle: the double SHA-256 catches it too.
    expect(
      bitcoinAddressKind(GENESIS_P2PKH.replace('eP5Q', 'eP5R')),
    ).toBeNull();
  });

  it('refuses testnet base58 addresses and other chains’ addresses', () => {
    expect(isBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false);
    expect(isBitcoinAddress('2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc')).toBe(false);
    expect(
      isBitcoinAddress('So11111111111111111111111111111111111111112'),
    ).toBe(false);
    expect(isBitcoinAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(
      false,
    );
    expect(isBitcoinAddress('')).toBe(false);
    expect(isBitcoinAddress('1'.repeat(10_000))).toBe(false);
  });
});

describe('normalizeBitcoinAddress', () => {
  it('lower-cases a segwit address and leaves base58 as given', () => {
    expect(
      normalizeBitcoinAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'),
    ).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(normalizeBitcoinAddress(TAPROOT)).toBe(TAPROOT);
    expect(normalizeBitcoinAddress(GENESIS_P2PKH)).toBe(GENESIS_P2PKH);
  });
});
