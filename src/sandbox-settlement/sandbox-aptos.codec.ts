import { ed25519 } from '@noble/curves/ed25519.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@/evm/rlp';
import {
  APTOS_FA_METADATA_TYPE,
  APTOS_FA_TRANSFER,
} from '@/sandbox-settlement/sandbox-aptos.constants';

/**
 * Aptos transactions, built and signed by hand (BCS over @noble): the one
 * kind the sandbox sends, an entry-function call of
 * `0x1::primary_fungible_store::transfer<0x1::fungible_asset::Metadata>`
 * signed by a single ed25519 key. Pinned in the spec to vectors from Aptos's
 * own SDK.
 */

/** Ed25519 single-key authentication scheme byte (the address derivation). */
const ED25519_SCHEME = 0x00;
/** `TransactionPayload::EntryFunction`. */
const PAYLOAD_ENTRY_FUNCTION = 2;
/** `TypeTag::Struct`. */
const TYPE_TAG_STRUCT = 7;
/** `TransactionAuthenticator::Ed25519`. */
const AUTHENTICATOR_ED25519 = 0;
/** `Transaction::UserTransaction`, the variant the hash covers. */
const TRANSACTION_USER = 0;
/** BCS tail of an Ed25519 authenticator: variant, 32-byte key, 64-byte signature. */
const ED25519_AUTHENTICATOR_LENGTH = 1 + 1 + 32 + 1 + 64;

const utf8 = (text: string) => new TextEncoder().encode(text);
const RAW_TRANSACTION_SALT = sha3_256(utf8('APTOS::RawTransaction'));
const TRANSACTION_SALT = sha3_256(utf8('APTOS::Transaction'));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function uleb128(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Uint8Array.from(out);
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 64n) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function readU64(bytes: Uint8Array, at: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at, true);
}

const bytesVec = (bytes: Uint8Array) => concat(uleb128(bytes.length), bytes);
const str = (text: string) => bytesVec(utf8(text));

/**
 * An address as its 32 BCS bytes: `0x` + 1 to 64 hex digits, left-padded (the
 * short form `0x1` is the same account as its 64-digit spelling).
 */
export function aptosAddressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    throw new Error(`Not an Aptos address: ${address}`);
  }
  return hexToBytes(`0x${address.slice(2).padStart(64, '0')}`);
}

/** The long spelling the sandbox stores and compares: `0x` + 64 lowercase hex. */
export function aptosLongAddress(address: string): string {
  return bytesToHex(aptosAddressBytes(address));
}

/** The account a single ed25519 key controls: SHA3-256(public key || 0x00). */
export function aptosAddressOfPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha3_256(concat(publicKey, Uint8Array.of(ED25519_SCHEME))));
}

/** The account of an ed25519 secret (its 32-byte seed). */
export function aptosAddressOfSecret(secret: Uint8Array): string {
  return aptosAddressOfPublicKey(ed25519.getPublicKey(secret));
}

/** One fungible-asset transfer from `sender`, and the terms it is signed under. */
export interface AptosFaTransfer {
  sender: string;
  sequenceNumber: bigint;
  /** The asset's metadata object (Circle's test USDC, or APT's `0xa`). */
  metadata: string;
  recipient: string;
  amount: bigint;
  maxGasAmount: bigint;
  gasUnitPrice: bigint;
  /** Unix seconds after which the transaction can never execute. */
  expirationSecs: bigint;
  chainId: number;
}

/** `RawTransaction` of a `primary_fungible_store::transfer`, in BCS. */
export function aptosFaTransferRaw(transfer: AptosFaTransfer): Uint8Array {
  if (
    !Number.isInteger(transfer.chainId) ||
    transfer.chainId < 0 ||
    transfer.chainId > 255
  ) {
    throw new Error(`Aptos chain id out of range: ${transfer.chainId}`);
  }
  const typeArg = concat(
    Uint8Array.of(TYPE_TAG_STRUCT),
    aptosAddressBytes(APTOS_FA_METADATA_TYPE.address),
    str(APTOS_FA_METADATA_TYPE.module),
    str(APTOS_FA_METADATA_TYPE.name),
    uleb128(0),
  );
  // Each entry-function argument is its own BCS bytes, wrapped as a vector.
  const args = [
    aptosAddressBytes(transfer.metadata),
    aptosAddressBytes(transfer.recipient),
    u64(transfer.amount),
  ];
  const payload = concat(
    uleb128(PAYLOAD_ENTRY_FUNCTION),
    aptosAddressBytes(APTOS_FA_TRANSFER.address),
    str(APTOS_FA_TRANSFER.module),
    str(APTOS_FA_TRANSFER.function),
    uleb128(1),
    typeArg,
    uleb128(args.length),
    ...args.map(bytesVec),
  );
  return concat(
    aptosAddressBytes(transfer.sender),
    u64(transfer.sequenceNumber),
    payload,
    u64(transfer.maxGasAmount),
    u64(transfer.gasUnitPrice),
    u64(transfer.expirationSecs),
    Uint8Array.of(transfer.chainId),
  );
}

/** What the key signs: SHA3-256("APTOS::RawTransaction") || raw. */
export function aptosSigningMessage(raw: Uint8Array): Uint8Array {
  return concat(RAW_TRANSACTION_SALT, raw);
}

/**
 * The transaction's id: SHA3-256(SHA3-256("APTOS::Transaction") || 0x00 ||
 * signed), lowercase `0x` + 64 hex, the spelling the explorer and the REST API
 * use (and the payment's `txHash`).
 */
export function aptosTransactionHash(signed: Uint8Array): string {
  return bytesToHex(
    sha3_256(concat(TRANSACTION_SALT, Uint8Array.of(TRANSACTION_USER), signed)),
  );
}

/** A transaction signed by one ed25519 key: its BCS bytes and its id. */
export interface SignedAptosTransaction {
  /** `SignedTransaction` in BCS, `0x` hex: what is submitted, and kept. */
  raw: string;
  hash: string;
}

/** Signs `raw` with `secret`: `SignedTransaction` = raw + Ed25519 authenticator. */
export function signAptosTransaction(
  raw: Uint8Array,
  secret: Uint8Array,
): SignedAptosTransaction {
  const signature = ed25519.sign(aptosSigningMessage(raw), secret);
  const signed = concat(
    raw,
    uleb128(AUTHENTICATOR_ED25519),
    bytesVec(ed25519.getPublicKey(secret)),
    bytesVec(signature),
  );
  return { raw: bytesToHex(signed), hash: aptosTransactionHash(signed) };
}

/** What `followAptos` needs back from stored signed bytes. */
export interface DecodedAptosTransaction {
  sender: string;
  sequenceNumber: bigint;
  expirationSecs: bigint;
  chainId: number;
  hash: string;
}

/**
 * Reads the sender, sequence number, expiration and chain id back from a
 * single-key signed transaction (the authenticator is fixed-length, so the
 * raw transaction's fixed tail sits right before it).
 */
export function decodeAptosSignedTransaction(
  rawHex: string,
): DecodedAptosTransaction {
  const signed = hexToBytes(rawHex);
  const end = signed.length - ED25519_AUTHENTICATOR_LENGTH;
  if (
    end < 32 + 8 + 8 + 8 + 8 + 1 ||
    signed[end] !== AUTHENTICATOR_ED25519 ||
    signed[end + 1] !== 32 ||
    signed[end + 34] !== 64
  ) {
    throw new Error('Not a single-key Aptos signed transaction');
  }
  return {
    sender: bytesToHex(signed.subarray(0, 32)),
    sequenceNumber: readU64(signed, 32),
    expirationSecs: readU64(signed, end - 9),
    chainId: signed[end - 1],
    hash: aptosTransactionHash(signed),
  };
}
