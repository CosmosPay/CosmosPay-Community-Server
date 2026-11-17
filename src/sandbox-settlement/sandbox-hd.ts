import { randomInt } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bigintToBytes, bytesToHex, hexToBytes } from '@/evm/rlp';
import { SANDBOX_DEPOSIT_PATH_PREFIX } from '@/sandbox-settlement/sandbox-settlement.constants';

/** BIP-32's hardened offset: index i' is i + 2^31. */
const HARDENED = 0x80000000;
const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** A BIP-32 extended private key: the key and its chain code. */
export interface ExtendedKey {
  key: Uint8Array;
  chainCode: Uint8Array;
}

function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, index >>> 0, false);
  return out;
}

/** A scalar as 32 big-endian bytes (BIP-32's ser256). */
function ser256(value: bigint): Uint8Array {
  const bytes = bigintToBytes(value);
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function parse256(bytes: Uint8Array): bigint {
  return BigInt(bytesToHex(bytes));
}

function split(I: Uint8Array): ExtendedKey {
  const key = I.subarray(0, 32);
  const k = parse256(key);
  if (k === 0n || k >= CURVE_ORDER) {
    // BIP-32: "the resulting key is invalid" (probability below 2^-127).
    throw new Error('BIP-32 derivation produced an invalid key');
  }
  return {
    key: Uint8Array.from(key),
    chainCode: Uint8Array.from(I.subarray(32)),
  };
}

/** BIP-32 master key of a seed: HMAC-SHA512("Bitcoin seed", seed). */
export function masterKey(seed: Uint8Array): ExtendedKey {
  return split(hmac(sha512, new TextEncoder().encode('Bitcoin seed'), seed));
}

/**
 * Hardened child derivation (CKDpriv for i >= 2^31):
 * I = HMAC-SHA512(c, 0x00 || ser256(k) || ser32(i)), k_i = (IL + k) mod n.
 * Hardened only: a leaked child key and the parent's chain code then reveal
 * nothing about the parent, so one deposit key never exposes the others.
 */
export function hardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
    throw new Error(`BIP-32 index out of range: ${index}`);
  }
  const data = new Uint8Array(37);
  data.set(parent.key, 1);
  data.set(ser32(index + HARDENED), 33);
  const I = hmac(sha512, parent.chainCode, data);
  const child =
    (parse256(I.subarray(0, 32)) + parse256(parent.key)) % CURVE_ORDER;
  if (parse256(I.subarray(0, 32)) >= CURVE_ORDER || child === 0n) {
    throw new Error('BIP-32 derivation produced an invalid key');
  }
  return { key: ser256(child), chainCode: Uint8Array.from(I.subarray(32)) };
}

/** The key at a path of hardened indexes (each written without the `'`). */
export function derivePath(
  seed: Uint8Array,
  path: readonly number[],
): ExtendedKey {
  return path.reduce(hardenedChild, masterKey(seed));
}

/**
 * The two random hardened indexes that place one deposit under
 * {@link SANDBOX_DEPOSIT_PATH_PREFIX}: 62 bits drawn from the OS's CSPRNG, so
 * replicas share no counter and a collision is a 2^-62 event.
 */
export function newDepositIndexes(): [number, number] {
  return [randomInt(0, HARDENED), randomInt(0, HARDENED)];
}

/** `m/44'/60'/7007'/a'/b'`, the path a deposit's key is stored under. */
export function depositPath(indexes: readonly [number, number]): string {
  return [
    'm',
    ...[...SANDBOX_DEPOSIT_PATH_PREFIX, ...indexes].map((i) => `${i}'`),
  ].join('/');
}

/** The indexes of a path {@link depositPath} wrote; null for anything else. */
export function parseDepositPath(path: string): [number, number] | null {
  const prefix = depositPath([0, 0]).split('/').slice(0, 4).join('/');
  const match = new RegExp(
    `^${prefix.replace(/'/g, "'")}/(\\d{1,10})'/(\\d{1,10})'$`,
  ).exec(path);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a < HARDENED && b < HARDENED ? [a, b] : null;
}

/** The secret key of one deposit address, from the sandbox seed (hex). */
export function depositSecretKey(
  seedHex: string,
  indexes: readonly [number, number],
): Uint8Array {
  return derivePath(hexToBytes(seedHex), [
    ...SANDBOX_DEPOSIT_PATH_PREFIX,
    ...indexes,
  ]).key;
}
