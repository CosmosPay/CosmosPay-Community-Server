import { EIP681_SCHEME } from '@/evm/evm.constants';

/** What an EIP-681 payment request carries. */
export interface Eip681Request {
  chainId: number;
  /** The payee. */
  recipient: string;
  /** In the asset's smallest unit (wei, or the token's base unit). */
  value: bigint;
  /** The ERC-20 contract, for a token payment; omit for the native coin. */
  token?: string;
}

/**
 * An EIP-681 URI: `ethereum:<payee>@<chainId>?value=<wei>` for the native coin,
 * `ethereum:<token>@<chainId>/transfer?address=<payee>&uint256=<units>` for an
 * ERC-20 — the form MetaMask and most EVM wallets open from a link or QR.
 * Values are written as plain integers, never in the spec's exponent form,
 * which not every wallet parses.
 */
export function eip681Uri(request: Eip681Request): string {
  if (request.token) {
    return (
      `${EIP681_SCHEME}${request.token}@${request.chainId}/transfer` +
      `?address=${request.recipient}&uint256=${request.value.toString()}`
    );
  }
  return (
    `${EIP681_SCHEME}${request.recipient}@${request.chainId}` +
    `?value=${request.value.toString()}`
  );
}

/** A 20-byte address as a 32-byte log topic, as `Transfer` indexes it. */
export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** The address inside a 32-byte log topic. */
export function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}
