import { keccak_256 } from '@noble/hashes/sha3.js';
import { toChecksumAddress } from '@/chains/chain-address';
import { DETERMINISTIC_DEPLOYER } from '@/evm/evm.constants';
import { PAYMENT_FORWARDER_ARTIFACT } from '@/evm/payment-forwarder.artifact';
import { bytesToHex, concat, hexToBytes } from '@/evm/rlp';

/** What a deposit address commits to. Change any field and the address changes. */
export interface ForwarderTerms {
  /** The merchant, EIP-55. */
  destination: string;
  /** ERC-20 contract, or null for the native coin. */
  token: string | null;
  /** Who deploys the forwarder, and is paid `fee` for it. */
  relayer: string;
  /** The relayer's fee, in the asset's base units. */
  fee: bigint;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function word(hex: string): string {
  return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** The forwarder's creation code with its constructor arguments appended. */
export function forwarderInitCode(terms: ForwarderTerms): string {
  return (
    PAYMENT_FORWARDER_ARTIFACT.bytecode +
    word(terms.destination) +
    word(terms.token ?? ZERO_ADDRESS) +
    word(terms.relayer) +
    word(terms.fee.toString(16))
  );
}

/**
 * The address `CREATE2` through the deterministic deployment proxy gives this
 * salt and init code: `keccak(0xff ++ proxy ++ salt ++ keccak(initCode))[12:]`.
 * Anyone can compute it, and anyone can deploy it — but only with these exact
 * terms, which is what makes paying to it safe before it exists.
 */
export function depositAddress(salt: string, initCode: string): string {
  return create2Address(DETERMINISTIC_DEPLOYER, salt, initCode);
}

/** EIP-1014: `keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]`. */
export function create2Address(
  deployer: string,
  salt: string,
  initCode: string,
): string {
  const hash = keccak_256(
    concat([
      Uint8Array.of(0xff),
      hexToBytes(deployer),
      hexToBytes(salt),
      keccak_256(hexToBytes(initCode)),
    ]),
  );
  return toChecksumAddress(bytesToHex(hash.subarray(12)));
}

/** Calldata for the proxy: `salt ++ initCode`, which it `CREATE2`s. */
export function deployCalldata(salt: string, initCode: string): string {
  return `0x${word(salt)}${initCode.replace(/^0x/, '')}`;
}

/** `flush()` — forwards a deployed forwarder's native balance. */
export const FLUSH_CALLDATA = '0x6b9f96ea';

/** `flushToken(token)` — forwards a deployed forwarder's token balance. */
export function flushTokenCalldata(token: string): string {
  return `0x9cee789f${word(token)}`;
}
