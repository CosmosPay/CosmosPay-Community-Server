import { StrKey } from '@stellar/stellar-sdk';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Chain } from '@/chains/chains.constants';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Decodes Bitcoin-alphabet base58 — Solana's encoding for keys, signatures and
 * hashes. Returns null for any character outside the alphabet.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let num = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    num = num * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num = num / 256n;
  }
  bytes.reverse();

  // Preserve leading zero bytes encoded as leading '1' characters.
  for (const char of value) {
    if (char !== '1') {
      break;
    }
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Encodes bytes as Bitcoin-alphabet base58. */
export function encodeBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }
  let out = '';
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)] + out;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    out = '1' + out;
  }
  return out;
}

/** A Solana address: base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(value: string): boolean {
  return decodeBase58(value)?.length === 32;
}

/** An EVM address: 0x + 40 hex. Shape only — any case is accepted. */
export function isEvmAddress(value: string): boolean {
  return typeof value === 'string' && EVM_ADDRESS_RE.test(value);
}

/**
 * The EIP-55 checksummed spelling of an EVM address. Addresses are stored in
 * this form so two spellings of one account (`0xabc…`, `0xABC…`) are one row,
 * one alias target and one payee — and so a destination never compares unequal
 * to the address a log reports.
 */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(Buffer.from(lower, 'ascii'))).toString(
    'hex',
  );
  let out = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/** What one chain accepts as an account address, and how an error names it. */
export interface ChainAddressRule {
  isValid(address: string): boolean;
  /** Completes "`<property>` must be … for chain `<chain>`". */
  expected: string;
  /**
   * The one spelling the service stores and compares. Identity for chains
   * whose encoding has a single spelling; EIP-55 for EVM.
   */
  normalize(address: string): string;
}

/**
 * Every chain's address rule. A `Record` over the chain union, so a chain
 * added to `CHAINS` does not compile until it says what its addresses are.
 */
export const CHAIN_ADDRESS_RULES: Record<Chain, ChainAddressRule> = {
  // G... account, checksum verified by StrKey.
  stellar: {
    isValid: (address) => StrKey.isValidEd25519PublicKey(address),
    expected: 'a valid Stellar account address (G...)',
    normalize: (address) => address,
  },
  // base58 that decodes to a 32-byte public key.
  solana: {
    isValid: isSolanaAddress,
    expected: 'a valid Solana address (base58, 32 bytes)',
    normalize: (address) => address,
  },
  monad: {
    isValid: isEvmAddress,
    expected: 'a valid Monad (EVM) address (0x + 40 hex)',
    normalize: toChecksumAddress,
  },
};

export function isAddressForChain(chain: Chain, address: string): boolean {
  return CHAIN_ADDRESS_RULES[chain].isValid(address);
}

export function normalizeAddress(chain: Chain, address: string): string {
  return CHAIN_ADDRESS_RULES[chain].normalize(address);
}
