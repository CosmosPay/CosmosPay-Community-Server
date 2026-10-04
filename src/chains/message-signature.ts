import { Keypair } from '@stellar/stellar-sdk';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decodeBase58, isEvmAddress } from '@/chains/chain-address';
import type { Chain } from '@/chains/chains.constants';

/**
 * Checking that an address signed a message, the way each chain's wallets sign
 * one.
 *
 *   - Stellar and Solana: ed25519 over the bytes, verified with the account's
 *     own public key. A Stellar G… and a Solana base58 address are two spellings
 *     of the same 32-byte key, so the difference is only in how the key and the
 *     signature arrive.
 *   - Monad (EVM): EIP-191 `personal_sign` — keccak-256 over
 *     `"\x19Ethereum Signed Message:\n" + length + message` — verified by
 *     recovering the signer and comparing addresses. The prefix is what makes a
 *     signed message impossible to submit as a transaction, the same guarantee
 *     the Stellar challenges get from their first line.
 *
 * Every function here returns a boolean and never throws: the inputs arrive
 * from the wire, and a verifier that crashes on junk is a denial of service on
 * the route that calls it.
 */

/** A 64-byte ed25519 signature from base64 (the Stellar wallets) or base58 (Solana's). */
function ed25519Signature(signature: string): Buffer | null {
  const b64 = Buffer.from(signature, 'base64');
  if (b64.length === 64) return b64;
  const b58 = decodeBase58(signature);
  return b58?.length === 64 ? Buffer.from(b58) : null;
}

function verifyEd25519(
  publicKey: Buffer,
  message: Uint8Array,
  signature: string,
): boolean {
  const sig = ed25519Signature(signature);
  if (!sig || publicKey.length !== 32) return false;
  return new Keypair({ type: 'ed25519', publicKey }).verify(
    Buffer.from(message),
    sig,
  );
}

/** The EIP-191 digest `personal_sign` signs. */
export function eip191Digest(message: Uint8Array): Uint8Array {
  const prefix = Buffer.from(
    `\x19Ethereum Signed Message:\n${message.length}`,
    'utf8',
  );
  return keccak_256(Buffer.concat([prefix, Buffer.from(message)]));
}

/** A 65-byte `r || s || v` signature from 0x-hex (what EVM wallets return) or base64. */
function evmSignature(signature: string): Buffer | null {
  if (/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return Buffer.from(signature.slice(2), 'hex');
  }
  const b64 = Buffer.from(signature, 'base64');
  return b64.length === 65 ? b64 : null;
}

/**
 * The address that produced an EIP-191 signature over `message`, lowercase, or
 * null when the signature is malformed. High-s signatures are refused (EIP-2):
 * each has a twin that recovers the same key, and accepting both is accepting
 * two signatures for one consent.
 */
export function recoverEvmSigner(
  message: Uint8Array,
  signature: string,
): string | null {
  try {
    const sig = evmSignature(signature);
    if (!sig) return null;
    const v = sig[64];
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return null;
    const parsed = secp256k1.Signature.fromBytes(
      sig.subarray(0, 64),
      'compact',
    );
    if (parsed.hasHighS()) return null;
    const point = parsed
      .addRecoveryBit(recovery)
      .recoverPublicKey(eip191Digest(message));
    const uncompressed = point.toBytes(false);
    const hash = keccak_256(uncompressed.subarray(1));
    return `0x${Buffer.from(hash.subarray(12)).toString('hex')}`;
  } catch {
    return null;
  }
}

/**
 * How each chain's address signs a message. A `Record` over the chain union,
 * so a new chain does not compile until it says how its wallets sign.
 */
const MESSAGE_VERIFIERS: Record<
  Chain,
  (address: string, message: Uint8Array, signature: string) => boolean
> = {
  stellar: (address, message, signature) => {
    try {
      return verifyEd25519(
        Buffer.from(Keypair.fromPublicKey(address).rawPublicKey()),
        message,
        signature,
      );
    } catch {
      return false;
    }
  },
  solana: (address, message, signature) => {
    const key = decodeBase58(address);
    return !!key && verifyEd25519(Buffer.from(key), message, signature);
  },
  monad: (address, message, signature) => {
    if (!isEvmAddress(address)) return false;
    const signer = recoverEvmSigner(message, signature);
    return signer !== null && signer === address.toLowerCase();
  },
};

/** Does `signature` prove that `address`, on `chain`, signed `message`? */
export function verifyMessageSignature(
  chain: Chain,
  address: string,
  message: Uint8Array | string,
  signature: string,
): boolean {
  try {
    const bytes =
      typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
    return MESSAGE_VERIFIERS[chain](address, bytes, signature);
  } catch {
    return false;
  }
}
