import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  addressOfSecretKey,
  decodeSignedEip1559,
  signEip1559,
  unsignedPayload,
} from '@/evm/evm-transaction';
import { bytesToHex, hexToBytes } from '@/evm/rlp';

const TX = {
  chainId: 10143,
  nonce: 7n,
  maxPriorityFeePerGas: 2_000_000_000n,
  maxFeePerGas: 200_000_000_000n,
  gasLimit: 480_000n,
  to: '0x4e59b44847b379578588920ca78fbf26c0b4956c',
  value: 0n,
  data: '0xdeadbeef',
};

/**
 * The address that signed `raw`. For a 32-byte r and s the envelope ends with
 * `yParity, 0xa0 ++ r, 0xa0 ++ s`, so the three can be read off the end.
 */
function recoverSigner(raw: string): string {
  const bytes = hexToBytes(raw);
  const s = bytes.subarray(bytes.length - 32);
  const r = bytes.subarray(bytes.length - 65, bytes.length - 33);
  const parityByte = bytes[bytes.length - 67];
  const yParity = parityByte === 0x80 ? 0 : parityByte; // RLP of 0 is 0x80
  const pub = secp256k1.Signature.fromBytes(
    Uint8Array.from([...r, ...s]),
    'compact',
  )
    .addRecoveryBit(yParity)
    .recoverPublicKey(keccak_256(unsignedPayload(TX)))
    .toBytes(false);
  return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
}

describe('signEip1559', () => {
  it('derives the address of a key (the well-known private key 1)', () => {
    const one = hexToBytes(`0x${'0'.repeat(63)}1`);
    expect(addressOfSecretKey(one)).toBe(
      '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    );
  });

  it('signs a type-2 envelope that recovers to the signer', () => {
    // `recoverSigner` needs a full-length r and s; draw keys until one gives it.
    for (let i = 0; i < 100; i += 1) {
      const key = secp256k1.utils.randomSecretKey();
      const signed = signEip1559(TX, key);
      const bytes = hexToBytes(signed.raw);
      if (
        bytes[bytes.length - 33] !== 0xa0 ||
        bytes[bytes.length - 66] !== 0xa0
      ) {
        continue;
      }
      expect(signed.raw.startsWith('0x02')).toBe(true);
      expect(signed.hash).toBe(bytesToHex(keccak_256(bytes)));
      expect(recoverSigner(signed.raw)).toBe(
        addressOfSecretKey(key).toLowerCase(),
      );
      return;
    }
    throw new Error('no full-length signature in 100 keys');
  });

  it('is deterministic (RFC 6979): the same key and fields sign the same bytes', () => {
    const key = secp256k1.utils.randomSecretKey();
    expect(signEip1559(TX, key).raw).toBe(signEip1559(TX, key).raw);
  });

  it('binds the chain id: the same fields on another chain are another transaction', () => {
    const key = secp256k1.utils.randomSecretKey();
    expect(signEip1559(TX, key).hash).not.toBe(
      signEip1559({ ...TX, chainId: 143 }, key).hash,
    );
  });
});

describe('decodeSignedEip1559', () => {
  const key = new Uint8Array(32).fill(7);

  it('reads the fields back and recovers who signed, not who claims to', () => {
    const signed = signEip1559({ ...TX, value: 10n ** 18n }, key);
    const tx = decodeSignedEip1559(signed.raw);

    expect(tx.from).toBe(addressOfSecretKey(key));
    expect(tx.hash).toBe(signed.hash);
    expect(tx).toMatchObject({
      chainId: TX.chainId,
      nonce: TX.nonce,
      gasLimit: TX.gasLimit,
      value: 10n ** 18n,
      data: TX.data,
    });
    expect(tx.to.toLowerCase()).toBe(TX.to);
  });

  it('refuses anything but a type-2 transaction', () => {
    const signed = signEip1559(TX, key);
    expect(() => decodeSignedEip1559(`0x01${signed.raw.slice(4)}`)).toThrow(
      'type 2',
    );
    expect(() => decodeSignedEip1559('0x02c0')).toThrow('12 fields');
  });
});
