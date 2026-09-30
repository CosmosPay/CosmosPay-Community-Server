import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeBase58 } from '@/chains/chain-address';

/**
 * The Solana transaction wire format, read far enough to check a signed swap:
 *
 *   shortvec(n) · n × 64-byte signatures · message
 *
 * and in the message, legacy or v0 (a leading `0x80` byte), the header's
 * `numRequiredSignatures` and the static account keys, whose first N are the
 * signers in signature order. Nothing past the keys is read: the message is
 * compared byte for byte with the one this service handed out, which is a
 * stronger check than interpreting its instructions.
 */
export interface ParsedSolanaTransaction {
  signatures: Uint8Array[];
  /** The signed bytes. */
  message: Uint8Array;
  numRequiredSignatures: number;
  /** The first static account keys, base58 — the signers come first. */
  signers: string[];
}

/** Solana's compact-u16: 7 bits per byte, at most 3 bytes. */
function readShortVec(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    if (at + i >= bytes.length) throw new Error('shortvec runs past the input');
    const byte = bytes[at + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error('shortvec is longer than 3 bytes');
}

export function parseSolanaTransaction(
  bytes: Uint8Array,
): ParsedSolanaTransaction {
  const [count, afterCount] = readShortVec(bytes, 0);
  const sigEnd = afterCount + count * 64;
  if (count === 0 || sigEnd > bytes.length) {
    throw new Error('no room for the signatures');
  }
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    signatures.push(
      bytes.subarray(afterCount + i * 64, afterCount + (i + 1) * 64),
    );
  }
  const message = bytes.subarray(sigEnd);

  let at = 0;
  if (message[at] & 0x80) {
    if (message[at] !== 0x80) throw new Error('unsupported message version');
    at += 1;
  }
  const numRequiredSignatures = message[at];
  at += 3;
  const [keyCount, keysStart] = readShortVec(message, at);
  if (keysStart + keyCount * 32 > message.length) {
    throw new Error('account keys run past the message');
  }
  if (numRequiredSignatures !== count || numRequiredSignatures > keyCount) {
    throw new Error('signature count does not match the message header');
  }
  const signers: string[] = [];
  for (let i = 0; i < numRequiredSignatures; i += 1) {
    signers.push(
      encodeBase58(
        message.subarray(keysStart + i * 32, keysStart + (i + 1) * 32),
      ),
    );
  }
  return { signatures, message, numRequiredSignatures, signers };
}

/**
 * Whether every required signature is present and valid over the message. An
 * all-zero slot is how an unsigned transaction marks a missing signature.
 */
export function hasValidSignatures(
  tx: ParsedSolanaTransaction,
  publicKeys: Uint8Array[],
): boolean {
  return tx.signatures.every((sig, i) => {
    if (sig.every((b) => b === 0)) return false;
    try {
      return ed25519.verify(sig, tx.message, publicKeys[i]);
    } catch {
      return false;
    }
  });
}

/** A transaction's id: its first signature, base58. */
export function transactionId(tx: ParsedSolanaTransaction): string {
  return encodeBase58(tx.signatures[0]);
}
