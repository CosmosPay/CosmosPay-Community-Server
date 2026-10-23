import { sha256 } from '@noble/hashes/sha2.js';
import { convertBits, decodeBech32 } from '@/chains/bech32';
import { decodeBase58 } from '@/chains/chain-address';
import {
  BITCOIN_BECH32_HRP,
  BITCOIN_P2PKH_VERSION,
  BITCOIN_P2SH_VERSION,
} from '@/chains/chains.constants';

/**
 * The Bitcoin mainnet output types a swap may pay to or refund to.
 *
 * Deliberately not "anything that decodes": a segwit address of a version no
 * soft fork has defined yet (v2–v16), or a v1 program that is not 32 bytes,
 * is valid bech32m and unspendable by anyone today. Money sent there is
 * stuck, so those are refused rather than handed to NEAR Intents to pay.
 */
export type BitcoinAddressKind =
  | 'p2pkh' // 1…, base58check
  | 'p2sh' // 3…, base58check
  | 'p2wpkh' // bc1q…, segwit v0, 20-byte program
  | 'p2wsh' // bc1q…, segwit v0, 32-byte program
  | 'p2tr'; // bc1p…, segwit v1 (taproot), 32-byte program

/** The longest a 25-byte base58check address can be written. */
const BASE58_ADDRESS_MAX_LENGTH = 35;

/** Version byte + 20-byte hash + 4-byte checksum. */
const BASE58_ADDRESS_BYTES = 25;
const BASE58_CHECKSUM_BYTES = 4;

/**
 * A segwit address's kind (BIP-173 for v0, BIP-350 for v1), or null. The
 * encoding must match the version — bech32 for v0, bech32m for v1 — which is
 * what stops a v1 address written with the old checksum from decoding.
 */
function segwitKind(address: string): BitcoinAddressKind | null {
  const decoded = decodeBech32(address);
  if (!decoded || decoded.hrp !== BITCOIN_BECH32_HRP) return null;
  if (decoded.data.length < 1) return null;
  const [version, ...words] = decoded.data;
  const program = convertBits(words, 5, 8, false);
  if (!program) return null;

  if (version === 0) {
    if (decoded.encoding !== 'bech32') return null;
    if (program.length === 20) return 'p2wpkh';
    if (program.length === 32) return 'p2wsh';
    return null;
  }
  if (version === 1) {
    if (decoded.encoding !== 'bech32m') return null;
    return program.length === 32 ? 'p2tr' : null;
  }
  return null;
}

/**
 * A legacy address's kind, or null: base58 that decodes to a version byte, a
 * 20-byte hash and the first four bytes of the double SHA-256 of the two.
 */
function base58Kind(address: string): BitcoinAddressKind | null {
  // Bounded before decoding: base58 is quadratic in its length, and nothing
  // longer can be an address anyway.
  if (address.length > BASE58_ADDRESS_MAX_LENGTH) return null;
  const raw = decodeBase58(address);
  if (!raw || raw.length !== BASE58_ADDRESS_BYTES) return null;
  const payload = raw.subarray(0, -BASE58_CHECKSUM_BYTES);
  const checksum = sha256(sha256(payload));
  for (let i = 0; i < BASE58_CHECKSUM_BYTES; i += 1) {
    if (checksum[i] !== raw[payload.length + i]) return null;
  }
  if (payload[0] === BITCOIN_P2PKH_VERSION) return 'p2pkh';
  if (payload[0] === BITCOIN_P2SH_VERSION) return 'p2sh';
  return null;
}

/** What kind of Bitcoin mainnet address `value` is; null when it is none. */
export function bitcoinAddressKind(value: string): BitcoinAddressKind | null {
  if (typeof value !== 'string') return null;
  return segwitKind(value) ?? base58Kind(value);
}

/** A Bitcoin mainnet address of one of the {@link BitcoinAddressKind}s. */
export function isBitcoinAddress(value: string): boolean {
  return bitcoinAddressKind(value) !== null;
}

/**
 * The one spelling stored: a segwit address in lower case — bech32 is
 * case-insensitive, and `BC1Q…` from a QR code is the same output as `bc1q…` —
 * and base58, which is case-sensitive, exactly as given.
 */
export function normalizeBitcoinAddress(value: string): string {
  return segwitKind(value) ? value.toLowerCase() : value;
}
