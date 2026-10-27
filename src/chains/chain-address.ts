import { StrKey } from '@stellar/stellar-sdk';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { CHAINS, type Chain } from '@/chains/chains.constants';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * The longest base58 string decoded: a 64-byte Solana signature is at most 88 characters.
 * Decoding is quadratic in the length (one BigInt multiply per character), so a longer
 * input is refused before any work, whatever field it arrived in.
 */
const MAX_BASE58_LENGTH = 128;

/**
 * Decodes Bitcoin-alphabet base58 (Solana's encoding for keys, signatures and hashes).
 * Returns null for any character outside the alphabet, or past MAX_BASE58_LENGTH.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_BASE58_LENGTH
  ) {
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
  // 32 bytes are 32 to 44 base58 characters; anything else is not one, so skip the decode.
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return false;
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

/**
 * The chain an address belongs to, read from its shape alone, for a field that names no
 * chain (a customer's `account`). The shapes do not overlap: a Stellar key is 56 base32
 * characters starting with G, a Solana key is base58 for 32 bytes (at most 44 characters, and
 * no `0`), a Monad address is 0x + 40 hex. Null when no rule accepts it, and also when more
 * than one would, so a future chain whose shape collides is refused rather than guessed.
 */
export function chainOfAddress(address: string): Chain | null {
  // No accepted address is longer than a Stellar key (56 characters).
  if (typeof address !== 'string' || address.length > 64) return null;
  const matches = CHAINS.filter((chain) =>
    CHAIN_ADDRESS_RULES[chain].isValid(address),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * `address` in the one spelling its chain stores (EIP-55 on Monad), or null when it is no
 * chain's address. See {@link chainOfAddress}.
 */
export function normalizeAnyChainAddress(address: string): string | null {
  const chain = chainOfAddress(address);
  return chain ? normalizeAddress(chain, address) : null;
}

/**
 * Completes "`<property>` must be ..." for a field that takes an address on any chain, from
 * each chain's own wording: "a valid Stellar account address (G...), a valid Solana address
 * (base58, 32 bytes) or a valid Monad (EVM) address (0x + 40 hex)".
 */
const EXPECTED_PER_CHAIN = CHAINS.map(
  (chain) => CHAIN_ADDRESS_RULES[chain].expected,
);
export const ANY_CHAIN_ADDRESS_EXPECTED = `${EXPECTED_PER_CHAIN.slice(0, -1).join(', ')} or ${EXPECTED_PER_CHAIN[EXPECTED_PER_CHAIN.length - 1]}`;
