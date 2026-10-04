import { Keypair } from '@stellar/stellar-sdk';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeBase58 } from '@/chains/chain-address';
import {
  eip191Digest,
  recoverEvmSigner,
  verifyMessageSignature,
} from '@/chains/message-signature';

const MESSAGE = 'Cosmos Pay Wallet sign-in\nchain: solana\nemail: a@b.c';

/** An EVM account: its key and 0x address. */
function evmAccount() {
  const secret = secp256k1.utils.randomSecretKey();
  const pub = secp256k1.getPublicKey(secret, false);
  const address = `0x${Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString('hex')}`;
  return { secret, address };
}

/** What `personal_sign` returns: 0x + r || s || v (27/28). */
function personalSign(secret: Uint8Array, message: string): string {
  const sig = secp256k1.sign(
    eip191Digest(Buffer.from(message, 'utf8')),
    secret,
    { prehash: false, format: 'recovered' },
  );
  // noble's `recovered` format is recovery || r || s.
  const recovery = sig[0];
  const rs = Buffer.from(sig.subarray(1));
  return `0x${rs.toString('hex')}${(27 + recovery).toString(16)}`;
}

describe('verifyMessageSignature', () => {
  describe('stellar', () => {
    it('verifies ed25519 over the UTF-8 bytes', () => {
      const kp = Keypair.random();
      const sig = Buffer.from(kp.sign(Buffer.from(MESSAGE))).toString('base64');
      expect(
        verifyMessageSignature('stellar', kp.publicKey(), MESSAGE, sig),
      ).toBe(true);
      expect(
        verifyMessageSignature(
          'stellar',
          Keypair.random().publicKey(),
          MESSAGE,
          sig,
        ),
      ).toBe(false);
    });
  });

  describe('solana', () => {
    const kp = Keypair.random();
    const address = encodeBase58(kp.rawPublicKey());
    const raw = Buffer.from(kp.sign(Buffer.from(MESSAGE)));

    it('verifies a base64 or a base58 signature', () => {
      expect(
        verifyMessageSignature(
          'solana',
          address,
          MESSAGE,
          raw.toString('base64'),
        ),
      ).toBe(true);
      expect(
        verifyMessageSignature('solana', address, MESSAGE, encodeBase58(raw)),
      ).toBe(true);
    });

    it('refuses another message, another key and junk', () => {
      expect(
        verifyMessageSignature(
          'solana',
          address,
          `${MESSAGE}!`,
          raw.toString('base64'),
        ),
      ).toBe(false);
      expect(
        verifyMessageSignature(
          'solana',
          encodeBase58(Keypair.random().rawPublicKey()),
          MESSAGE,
          raw.toString('base64'),
        ),
      ).toBe(false);
      expect(verifyMessageSignature('solana', address, MESSAGE, 'junk')).toBe(
        false,
      );
      expect(
        verifyMessageSignature('solana', 'not-base58!', MESSAGE, 'x'),
      ).toBe(false);
    });
  });

  describe('monad (EIP-191)', () => {
    it('recovers the signer of a personal_sign signature', () => {
      const { secret, address } = evmAccount();
      const sig = personalSign(secret, MESSAGE);
      expect(recoverEvmSigner(Buffer.from(MESSAGE), sig)).toBe(address);
      expect(verifyMessageSignature('monad', address, MESSAGE, sig)).toBe(true);
      // Any case of the address is the same account.
      expect(
        verifyMessageSignature(
          'monad',
          address.toUpperCase().replace('0X', '0x'),
          MESSAGE,
          sig,
        ),
      ).toBe(true);
    });

    it('matches a published web3 vector', () => {
      // web3.eth.accounts.sign('Some data', '0x4c0883a6…362318')
      expect(
        recoverEvmSigner(
          Buffer.from('Some data'),
          '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c',
        ),
      ).toBe('0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
    });

    it('refuses another signer, another message, a high-s twin and junk', () => {
      const { secret, address } = evmAccount();
      const sig = personalSign(secret, MESSAGE);
      expect(
        verifyMessageSignature('monad', evmAccount().address, MESSAGE, sig),
      ).toBe(false);
      expect(verifyMessageSignature('monad', address, `${MESSAGE}!`, sig)).toBe(
        false,
      );

      // s' = n - s recovers the same key with the other parity: refused (EIP-2).
      const bytes = Buffer.from(sig.slice(2), 'hex');
      const n = secp256k1.Point.CURVE().n;
      const s = BigInt(`0x${bytes.subarray(32, 64).toString('hex')}`);
      const twin = Buffer.concat([
        bytes.subarray(0, 32),
        Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex'),
        Buffer.from([bytes[64] === 27 ? 28 : 27]),
      ]);
      expect(
        verifyMessageSignature(
          'monad',
          address,
          MESSAGE,
          `0x${twin.toString('hex')}`,
        ),
      ).toBe(false);

      expect(verifyMessageSignature('monad', address, MESSAGE, '0x1234')).toBe(
        false,
      );
      expect(verifyMessageSignature('monad', 'nope', MESSAGE, sig)).toBe(false);
    });
  });
});
