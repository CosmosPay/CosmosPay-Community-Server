import { ed25519 } from '@noble/curves/ed25519.js';
import {
  encodeNearTransaction,
  nearAccountOfSecret,
  nearPublicKeyString,
  type NearTransaction,
  signNearTransaction,
} from '@/sandbox-settlement/sandbox-near.codec';

/**
 * Vectors from NEAR's own library (`@near-js/transactions` 1.3.3 and
 * `@near-js/crypto`): `createTransaction` + `encodeTransaction` for the bytes,
 * `KeyPair.sign` of SHA-256 for the signature, `SignedTransaction` for the
 * signed bytes, over the same key, nonce, block hash and actions.
 */
const SECRET = new Uint8Array(32).fill(7);
const IMPLICIT =
  'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

const TX: NearTransaction = {
  signerId: IMPLICIT,
  publicKey: ed25519.getPublicKey(SECRET),
  nonce: 123456789012n,
  receiverId: USDC,
  blockHash: new Uint8Array(32).fill(9),
  actions: [
    {
      methodName: 'storage_deposit',
      args: { account_id: 'merchant.testnet', registration_only: true },
      gas: 10_000_000_000_000n,
      deposit: 1_250_000_000_000_000_000_000n,
    },
    {
      methodName: 'ft_transfer',
      args: { receiver_id: 'merchant.testnet', amount: '25000000' },
      gas: 15_000_000_000_000n,
      deposit: 1n,
    },
  ],
};

const TX_BYTES =
  '4000000065613461366336336532396335323061626566353530376231333265633566393935' +
  '34373736616562656265376239323432316565613639313434366432326300ea4a6c63e29c52' +
  '0abef5507b132ec5f9954776aebebe7b92421eea691446d22c141a99be1c0000004000000033' +
  '6532323130653131383462343562363463386134333463306137653762323363633034656137' +
  '6562376136633363333235323064303364346166636238616609090909090909090909090909' +
  '0909090909090909090909090909090909090902000000020f00000073746f726167655f6465' +
  '706f7369743a0000007b226163636f756e745f6964223a226d65726368616e742e746573746e' +
  '6574222c22726567697374726174696f6e5f6f6e6c79223a747275657d00a0724e1809000000' +
  '00485637193cc34300000000000000020b00000066745f7472616e73666572360000007b2272' +
  '656365697665725f6964223a226d65726368616e742e746573746e6574222c22616d6f756e74' +
  '223a223235303030303030227d00f0ab75a40d000001000000000000000000000000000000';

const SIGNED_BASE64 =
  'QAAAAGVhNGE2YzYzZTI5YzUyMGFiZWY1NTA3YjEzMmVjNWY5OTU0Nzc2YWViZWJlN2I5MjQyMWVlYTY5MTQ0NmQyMmMA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwUGpm+HAAAAEAAAAAzZTIyMTBlMTE4NGI0NWI2NGM4YTQzNGMwYTdlN2IyM2NjMDRlYTdlYjdhNmMzYzMyNTIwZDAzZDRhZmNiOGFmCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkCAAAAAg8AAABzdG9yYWdlX2RlcG9zaXQ6AAAAeyJhY2NvdW50X2lkIjoibWVyY2hhbnQudGVzdG5ldCIsInJlZ2lzdHJhdGlvbl9vbmx5Ijp0cnVlfQCgck4YCQAAAABIVjcZPMNDAAAAAAAAAAILAAAAZnRfdHJhbnNmZXI2AAAAeyJyZWNlaXZlcl9pZCI6Im1lcmNoYW50LnRlc3RuZXQiLCJhbW91bnQiOiIyNTAwMDAwMCJ9APCrdaQNAAABAAAAAAAAAAAAAAAAAAAAAIYvxySYoOCjdFaGtiCIdxZvGaxbp6S1R3qfJ3PJ6Yz3Nqj0Tr4eTZ4j8/SygYYWQSVcXjfL2h22yEp76tpBYAs=';

describe('NEAR transaction codec', () => {
  it('names the implicit account of a key: the hex of its ed25519 public key', () => {
    expect(nearAccountOfSecret(SECRET)).toBe(IMPLICIT);
    expect(nearPublicKeyString(TX.publicKey)).toMatch(/^ed25519:[1-9A-z]+$/);
  });

  it("writes a two-action function-call transaction in Borsh byte for byte as NEAR's library", () => {
    expect(Buffer.from(encodeNearTransaction(TX)).toString('hex')).toBe(
      TX_BYTES,
    );
  });

  it("signs SHA-256 of those bytes and hashes it as NEAR's library", () => {
    const signed = signNearTransaction(TX, SECRET);
    expect(signed.hash).toBe('76YwFwgDr5kUTFRrTjD3uFJGURKmKfW9zAhVoSGSJ4kn');
    expect(signed.raw).toBe(SIGNED_BASE64);
  });

  it('refuses a key that is not the one the transaction names', () => {
    expect(() => signNearTransaction(TX, new Uint8Array(32).fill(8))).toThrow(
      /another public key/,
    );
  });

  it('refuses an amount past its Borsh width', () => {
    expect(() => encodeNearTransaction({ ...TX, nonce: 1n << 64n })).toThrow(
      /out of range/,
    );
  });
});
