import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeBase58 } from '@/chains/chain-address';

/**
 * NEAR transactions, written by hand in Borsh (the encoding nearcore signs and
 * hashes), for the sandbox treasury's function calls on test networks. Only
 * what the sandbox sends: ed25519 keys and `FunctionCall` actions. Pinned to
 * vectors from NEAR's own JavaScript library in the spec.
 */

/** One `FunctionCall` action: a contract method, its JSON args and what it attaches. */
export interface NearFunctionCall {
  methodName: string;
  /** The method's arguments, sent as UTF-8 JSON. */
  args: Record<string, unknown>;
  gas: bigint;
  /** yoctoNEAR attached. */
  deposit: bigint;
}

export interface NearTransaction {
  signerId: string;
  /** The signer's ed25519 public key (32 bytes). */
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  /** A recent block's hash (32 bytes): the transaction expires with it. */
  blockHash: Uint8Array;
  actions: NearFunctionCall[];
}

/** A signed transaction, as the sandbox keeps and broadcasts it. */
export interface SignedNearTransaction {
  /** base58 of SHA-256 of the Borsh transaction: the id explorers and `tx` use. */
  hash: string;
  /** base64 of the Borsh `SignedTransaction`, what `send_tx` takes. */
  raw: string;
}

/** `FunctionCall` is variant 2 of nearcore's `Action` enum. */
const FUNCTION_CALL_ACTION = 2;
/** `ED25519` is variant 0 of `KeyType`, for keys and signatures alike. */
const ED25519_KEY_TYPE = 0;

/** A Borsh writer for the few shapes a transaction uses. */
class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    this.parts.push(out);
    return this;
  }

  /** Little-endian unsigned integer of `bytes` bytes (u64: 8, u128: 16). */
  uint(value: bigint, bytes: number): this {
    if (value < 0n || value >= 1n << BigInt(bytes * 8)) {
      throw new Error(`Borsh u${bytes * 8} out of range: ${value}`);
    }
    const out = new Uint8Array(bytes);
    let rest = value;
    for (let i = 0; i < bytes; i++) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    this.parts.push(out);
    return this;
  }

  fixed(bytes: Uint8Array): this {
    this.parts.push(Uint8Array.from(bytes));
    return this;
  }

  /** `Vec<u8>`: a u32 length, then the bytes. */
  bytes(bytes: Uint8Array): this {
    return this.u32(bytes.length).fixed(bytes);
  }

  string(value: string): this {
    return this.bytes(new TextEncoder().encode(value));
  }

  done(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** A NEAR implicit account id: the 64 lowercase hex of the ed25519 public key. */
export function nearImplicitAccount(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('A NEAR implicit account is a 32-byte ed25519 key');
  }
  return Buffer.from(publicKey).toString('hex');
}

/** The implicit account an ed25519 secret (32-byte seed) controls. */
export function nearAccountOfSecret(secret: Uint8Array): string {
  return nearImplicitAccount(ed25519.getPublicKey(secret));
}

/** `ed25519:<base58>`, how NEAR's RPC names a public key. */
export function nearPublicKeyString(publicKey: Uint8Array): string {
  return `ed25519:${encodeBase58(publicKey)}`;
}

/** The Borsh bytes of a transaction: what is hashed, then signed. */
export function encodeNearTransaction(tx: NearTransaction): Uint8Array {
  if (tx.publicKey.length !== 32 || tx.blockHash.length !== 32) {
    throw new Error('A NEAR transaction takes a 32-byte key and block hash');
  }
  const w = new BorshWriter()
    .string(tx.signerId)
    .u8(ED25519_KEY_TYPE)
    .fixed(tx.publicKey)
    .uint(tx.nonce, 8)
    .string(tx.receiverId)
    .fixed(tx.blockHash)
    .u32(tx.actions.length);
  for (const action of tx.actions) {
    w.u8(FUNCTION_CALL_ACTION)
      .string(action.methodName)
      .bytes(new TextEncoder().encode(JSON.stringify(action.args)))
      .uint(action.gas, 8)
      .uint(action.deposit, 16);
  }
  return w.done();
}

/**
 * Signs `tx` with `secret` (the 32-byte ed25519 seed whose public key the
 * transaction names): ed25519 over SHA-256 of its Borsh bytes, appended as a
 * `Signature` (key type 0, 64 bytes).
 */
export function signNearTransaction(
  tx: NearTransaction,
  secret: Uint8Array,
): SignedNearTransaction {
  const publicKey = ed25519.getPublicKey(secret);
  if (Buffer.compare(Buffer.from(publicKey), Buffer.from(tx.publicKey)) !== 0) {
    throw new Error('The NEAR transaction names another public key');
  }
  const body = encodeNearTransaction(tx);
  const digest = sha256(body);
  const signature = ed25519.sign(digest, secret);
  const signed = new BorshWriter()
    .fixed(body)
    .u8(ED25519_KEY_TYPE)
    .fixed(signature)
    .done();
  return {
    hash: encodeBase58(digest),
    raw: Buffer.from(signed).toString('base64'),
  };
}
