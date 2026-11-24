import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { decodeBase58, encodeBase58 } from '@/chains/chain-address';

/**
 * Sui transactions, by hand: the BCS of a `TransactionData::V1` carrying one
 * programmable transaction that moves a coin to a recipient, its digest and
 * its ed25519 signature. Pure (no node, no clock), pinned in its spec to bytes
 * the official SDK produced for the same inputs.
 *
 * Only what the sandbox sends is encoded: owned object inputs, two pure
 * inputs, and the MergeCoins / SplitCoins / TransferObjects commands.
 */

/** An owned object at one version, as a transaction spends it. */
export interface SuiObjectRef {
  /** 0x + 64 hex. */
  objectId: string;
  version: bigint;
  /** The object digest, base58 (32 bytes). */
  digest: string;
}

/** A transfer of `amount` of the coins' type to `recipient`. */
export interface SuiCoinTransfer {
  sender: string;
  /** The sender's coins of the transferred type (at least one); merged first. */
  coins: SuiObjectRef[];
  recipient: string;
  amount: bigint;
  /** The sender's SUI coins that pay for gas (never one of `coins`). */
  gasPayment: SuiObjectRef[];
  gasPrice: bigint;
  gasBudget: bigint;
}

/** Signature scheme flag of ed25519 in a serialized Sui signature. */
const ED25519_FLAG = 0x00;
/** Intent prefix of a transaction: scope TransactionData, version V0, app Sui. */
const TRANSACTION_INTENT = [0, 0, 0];

class BcsWriter {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  u64(value: bigint): this {
    if (value < 0n || value >= 1n << 64n) {
      throw new Error(`u64 out of range: ${value}`);
    }
    for (let i = 0n; i < 8n; i++) this.u8(Number((value >> (8n * i)) & 0xffn));
    return this;
  }

  uleb128(value: number): this {
    let rest = value;
    do {
      const byte = rest & 0x7f;
      rest >>>= 7;
      this.u8(rest ? byte | 0x80 : byte);
    } while (rest);
    return this;
  }

  raw(data: Uint8Array): this {
    for (const b of data) this.bytes.push(b);
    return this;
  }

  /** A length-prefixed byte vector. */
  vecBytes(data: Uint8Array): this {
    return this.uleb128(data.length).raw(data);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** 32 bytes of a 0x-hex Sui address or object id. */
export function suiAddressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    throw new Error(`"${address}" is not a Sui address`);
  }
  return Uint8Array.from(
    Buffer.from(address.slice(2).padStart(64, '0'), 'hex'),
  );
}

/** The 0x + 64 lowercase hex spelling of a Sui address. */
export function normalizeSuiAddress(address: string): string {
  return `0x${Buffer.from(suiAddressBytes(address)).toString('hex')}`;
}

/** The address of an ed25519 key: blake2b-256(flag 0x00 || public key). */
export function suiAddressOfPublicKey(publicKey: Uint8Array): string {
  const data = new Uint8Array(33);
  data[0] = ED25519_FLAG;
  data.set(publicKey, 1);
  return `0x${Buffer.from(blake2b(data, { dkLen: 32 })).toString('hex')}`;
}

/** The address an ed25519 secret (32-byte seed) controls. */
export function suiAddressOfSecret(secret: Uint8Array): string {
  return suiAddressOfPublicKey(ed25519.getPublicKey(secret));
}

function objectRef(w: BcsWriter, ref: SuiObjectRef): void {
  const digest = decodeBase58(ref.digest);
  if (!digest || digest.length !== 32) {
    throw new Error(`"${ref.digest}" is not a Sui object digest`);
  }
  w.raw(suiAddressBytes(ref.objectId)).u64(ref.version).vecBytes(digest);
}

/** Argument::Input(i). */
const input = (w: BcsWriter, index: number) => w.u8(1).u16(index);

/**
 * The BCS of `TransactionData::V1` for `transfer`: inputs are the coins
 * (ImmOrOwnedObject), then the amount (pure u64) and the recipient (pure
 * address), in that order; commands are MergeCoins(coin 0, the others) when
 * there are several, SplitCoins(coin 0, [amount]) and TransferObjects([the
 * split], recipient). Gas is paid from `gasPayment`; no expiration.
 */
export function suiCoinTransferBcs(transfer: SuiCoinTransfer): Uint8Array {
  const { coins } = transfer;
  if (coins.length === 0) throw new Error('A transfer needs at least one coin');
  if (transfer.gasPayment.length === 0) {
    throw new Error('A transfer needs at least one gas coin');
  }
  const amountIndex = coins.length;
  const recipientIndex = coins.length + 1;
  const w = new BcsWriter();
  w.u8(0); // TransactionData::V1
  w.u8(0); // TransactionKind::ProgrammableTransaction

  w.uleb128(coins.length + 2);
  for (const coin of coins) {
    w.u8(1).u8(0); // CallArg::Object(ObjectArg::ImmOrOwnedObject)
    objectRef(w, coin);
  }
  w.u8(0).vecBytes(new BcsWriter().u64(transfer.amount).done()); // CallArg::Pure
  w.u8(0).vecBytes(suiAddressBytes(transfer.recipient)); // CallArg::Pure

  const merge = coins.length > 1;
  w.uleb128(merge ? 3 : 2);
  if (merge) {
    w.u8(3); // Command::MergeCoins
    input(w, 0);
    w.uleb128(coins.length - 1);
    for (let i = 1; i < coins.length; i++) input(w, i);
  }
  w.u8(2); // Command::SplitCoins
  input(w, 0);
  w.uleb128(1);
  input(w, amountIndex);
  w.u8(1); // Command::TransferObjects
  w.uleb128(1);
  w.u8(3)
    .u16(merge ? 1 : 0)
    .u16(0); // Argument::NestedResult(split, 0)
  input(w, recipientIndex);

  w.raw(suiAddressBytes(transfer.sender));
  w.uleb128(transfer.gasPayment.length);
  for (const gas of transfer.gasPayment) objectRef(w, gas);
  w.raw(suiAddressBytes(transfer.sender)); // gas owner
  w.u64(transfer.gasPrice);
  w.u64(transfer.gasBudget);
  w.u8(0); // TransactionExpiration::None
  return w.done();
}

/** A transaction's digest: base58(blake2b-256("TransactionData::" || bcs)). */
export function suiTransactionDigest(txBytes: Uint8Array): string {
  const prefix = new TextEncoder().encode('TransactionData::');
  const data = new Uint8Array(prefix.length + txBytes.length);
  data.set(prefix);
  data.set(txBytes, prefix.length);
  return encodeBase58(blake2b(data, { dkLen: 32 }));
}

/**
 * The serialized signature of a transaction (base64 of flag 0x00 || ed25519
 * signature || public key), the signature over blake2b-256 of the intent
 * message (`[0, 0, 0] || bcs`).
 */
export function signSuiTransaction(
  txBytes: Uint8Array,
  secret: Uint8Array,
): string {
  const message = new Uint8Array(TRANSACTION_INTENT.length + txBytes.length);
  message.set(TRANSACTION_INTENT);
  message.set(txBytes, TRANSACTION_INTENT.length);
  const signature = ed25519.sign(blake2b(message, { dkLen: 32 }), secret);
  const serialized = new Uint8Array(1 + 64 + 32);
  serialized[0] = ED25519_FLAG;
  serialized.set(signature, 1);
  serialized.set(ed25519.getPublicKey(secret), 65);
  return Buffer.from(serialized).toString('base64');
}

/**
 * What `sandbox_payout.raw` keeps of a Sui transaction: the transaction bytes
 * and its one signature, both base64, joined by a dot, so the exact same
 * execution can be sent again.
 */
export function packSuiSigned(txBytes: Uint8Array, signature: string): string {
  return `${Buffer.from(txBytes).toString('base64')}.${signature}`;
}

/** The two halves {@link packSuiSigned} joined. */
export function unpackSuiSigned(raw: string): {
  txBytes: string;
  signature: string;
} {
  const [txBytes, signature, extra] = raw.split('.');
  if (!txBytes || !signature || extra !== undefined) {
    throw new Error('Not a packed Sui transaction');
  }
  return { txBytes, signature };
}
