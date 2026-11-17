import { addressOfSecretKey } from '@/evm/evm-transaction';
import { bytesToHex } from '@/evm/rlp';
import {
  depositPath,
  depositSecretKey,
  derivePath,
  masterKey,
  newDepositIndexes,
  parseDepositPath,
} from '@/sandbox-settlement/sandbox-hd';

/** BIP-32 test vector 1 (bips/bip-0032.mediawiki). */
const VECTOR1_SEED = Uint8Array.from(
  Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
);

describe('sandbox HD derivation (BIP-32, hardened)', () => {
  it('derives BIP-32 test vector 1: m and m/0H', () => {
    const m = masterKey(VECTOR1_SEED);
    expect(bytesToHex(m.key)).toBe(
      '0xe8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
    );
    expect(bytesToHex(m.chainCode)).toBe(
      '0x873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508',
    );
    const child = derivePath(VECTOR1_SEED, [0]);
    expect(bytesToHex(child.key)).toBe(
      '0xedb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea',
    );
    expect(bytesToHex(child.chainCode)).toBe(
      '0x47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141',
    );
  });

  it('gives one address per path, the same every time, and a different one per path', () => {
    const seed = '0x' + '11'.repeat(32);
    const a = addressOfSecretKey(depositSecretKey(seed, [1, 2]));
    expect(addressOfSecretKey(depositSecretKey(seed, [1, 2]))).toBe(a);
    expect(addressOfSecretKey(depositSecretKey(seed, [1, 3]))).not.toBe(a);
    expect(addressOfSecretKey(depositSecretKey(seed, [2, 2]))).not.toBe(a);
    expect(
      addressOfSecretKey(depositSecretKey('0x' + '12'.repeat(32), [1, 2])),
    ).not.toBe(a);
  });

  it('writes and reads back the deposit path, refusing anything else', () => {
    const path = depositPath([5, 2147483647]);
    expect(path).toBe("m/44'/60'/7007'/5'/2147483647'");
    expect(parseDepositPath(path)).toEqual([5, 2147483647]);
    expect(parseDepositPath("m/44'/60'/7007'/5'/2147483648'")).toBeNull();
    expect(parseDepositPath("m/44'/60'/0'/5'/6'")).toBeNull();
    expect(parseDepositPath('garbage')).toBeNull();
  });

  it('draws two hardened indexes per deposit', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const [a, b] = newDepositIndexes();
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(2 ** 31);
      expect(b).toBeLessThan(2 ** 31);
      seen.add(`${a}:${b}`);
    }
    expect(seen.size).toBe(50);
  });
});
