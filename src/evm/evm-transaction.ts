import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toChecksumAddress } from '@/chains/chain-address';
import {
  bigintToBytes,
  bytesToHex,
  concat,
  hexToBytes,
  type RlpItem,
  rlpDecode,
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

/** A signed type-2 transaction, read back: its fields, signer and hash. */
export interface DecodedEip1559 extends Eip1559Transaction {
  /** The address that signed it, EIP-55 — recovered, not claimed. */
  from: string;
  hash: string;
}

/**
 * Reads a signed EIP-1559 transaction (`0x02 || rlp(...)`) and recovers who
 * signed it. Only type 2: it is what every wallet sends on Monad, and a legacy
 * or type-1 envelope is refused rather than half-understood. Throws on
 * anything malformed.
 */
export function decodeSignedEip1559(raw: string): DecodedEip1559 {
  const bytes = hexToBytes(raw);
  if (bytes[0] !== 0x02) {
    throw new Error('not an EIP-1559 (type 2) transaction');
  }
  const item = rlpDecode(bytes.subarray(1));
  if (!Array.isArray(item) || item.length !== 12) {
    throw new Error('a type-2 transaction has 12 fields');
  }
  const [chainId, nonce, tip, maxFee, gas, to, value, data, access, v, r, s] =
    item;
  const field = (x: RlpItem, name: string): Uint8Array => {
    if (!(x instanceof Uint8Array)) throw new Error(`${name} must be bytes`);
    return x;
  };
  const num = (x: RlpItem, name: string) => {
    const b = field(x, name);
    return b.length ? BigInt(bytesToHex(b)) : 0n;
  };
  const toBytes = field(to, 'to');
  if (toBytes.length !== 20) {
    throw new Error('a contract creation is not a swap');
  }
  if (!Array.isArray(access) || access.length !== 0) {
    throw new Error('an access list is not expected on a swap');
  }
  const tx: Eip1559Transaction = {
    chainId: Number(num(chainId, 'chainId')),
    nonce: num(nonce, 'nonce'),
    maxPriorityFeePerGas: num(tip, 'maxPriorityFeePerGas'),
    maxFeePerGas: num(maxFee, 'maxFeePerGas'),
    gasLimit: num(gas, 'gasLimit'),
    to: toChecksumAddress(bytesToHex(toBytes)),
    value: num(value, 'value'),
    data: bytesToHex(field(data, 'data')),
  };
  const yParity = num(v, 'yParity');
  if (yParity > 1n) throw new Error('yParity must be 0 or 1');
  const sig = new secp256k1.Signature(
    num(r, 'r'),
    num(s, 's'),
    Number(yParity),
  );
  const pub = sig
    .recoverPublicKey(keccak_256(unsignedPayload(tx)))
    .toBytes(false);
  const from = toChecksumAddress(
    bytesToHex(keccak_256(pub.subarray(1)).subarray(12)),
  );
  return { ...tx, from, hash: bytesToHex(keccak_256(bytes)) };
}
