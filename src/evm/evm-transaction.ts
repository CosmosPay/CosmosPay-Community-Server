import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toChecksumAddress } from '@/chains/chain-address';
import {
  bigintToBytes,
  bytesToHex,
  concat,
  hexToBytes,
  rlpEncode,
} from '@/evm/rlp';

/** An EIP-1559 (type 2) transaction, before signing. */
export interface Eip1559Transaction {
  chainId: number;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: string;
}

export interface SignedTransaction {
  /** What `eth_sendRawTransaction` takes. */
  raw: string;
  /** The transaction hash the chain will report. */
  hash: string;
}

/** The EVM address of a secp256k1 secret key, EIP-55. */
export function addressOfSecretKey(secretKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(secretKey, false);
  return toChecksumAddress(
    bytesToHex(keccak_256(pub.subarray(1)).subarray(12)),
  );
}

function fields(tx: Eip1559Transaction) {
  return [
    bigintToBytes(BigInt(tx.chainId)),
    bigintToBytes(tx.nonce),
    bigintToBytes(tx.maxPriorityFeePerGas),
    bigintToBytes(tx.maxFeePerGas),
    bigintToBytes(tx.gasLimit),
    hexToBytes(tx.to),
    bigintToBytes(tx.value),
    hexToBytes(tx.data),
    [], // access list
  ];
}

/** `0x02 || rlp(fields)` — the bytes whose keccak a type-2 signature signs. */
export function unsignedPayload(tx: Eip1559Transaction): Uint8Array {
  return concat([Uint8Array.of(0x02), rlpEncode(fields(tx))]);
}

/**
 * Signs a type-2 transaction: keccak over `0x02 || rlp(fields)`, a low-s
 * secp256k1 signature, then `0x02 || rlp(fields ++ [yParity, r, s])`. The
 * chain id is inside the signed fields (EIP-155), so the signature is worth
 * nothing on any other chain.
 */
export function signEip1559(
  tx: Eip1559Transaction,
  secretKey: Uint8Array,
): SignedTransaction {
  const digest = keccak_256(unsignedPayload(tx));
  // `recovered` is recovery || r || s, low-s by default.
  const sig = secp256k1.sign(digest, secretKey, {
    prehash: false,
    format: 'recovered',
  });
  const yParity = sig[0];
  const r = BigInt(bytesToHex(sig.subarray(1, 33)));
  const s = BigInt(bytesToHex(sig.subarray(33, 65)));
  const raw = concat([
    Uint8Array.of(0x02),
    rlpEncode([
      ...fields(tx),
      bigintToBytes(BigInt(yParity)),
      bigintToBytes(r),
      bigintToBytes(s),
    ]),
  ]);
  return { raw: bytesToHex(raw), hash: bytesToHex(keccak_256(raw)) };
}
