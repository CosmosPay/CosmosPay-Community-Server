import { MERCHANT_FEE_SWAP_ROUTER_ARTIFACT } from '@/evm/merchant-fee-swap-router.artifact';
import {
  MERCHANT_FEE_ROUTER_AGGREGATOR_SELECTOR,
  MERCHANT_FEE_ROUTER_SWAP_SELECTOR,
} from '@/evm/evm.constants';

/**
 * `contracts/MerchantFeeSwapRouter.sol` as this service speaks to it: the swap
 * calldata a wallet signs, and what checks that a configured address really is
 * that contract. Pure; the RPC calls are the venue's.
 */

/** A 32-byte ABI word: an address or an unsigned integer, left-padded. */
function word(value: string | bigint): string {
  const hex =
    typeof value === 'bigint'
      ? value.toString(16)
      : value.toLowerCase().replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/** What one swap through the router names; `address(0)` is native MON. */
export interface MerchantFeeSwapCall {
  tokenIn: string;
  amountIn: bigint;
  tokenOut: string;
  minOut: bigint;
  feeWallet: string;
  fee: bigint;
  recipient: string;
  /** The aggregator's own calldata, quoted for the router as the user. */
  data: string;
}

/**
 * `swap(address,uint256,address,uint256,address,uint256,address,bytes)`
 * calldata: seven static words, then the offset, length and padded bytes of
 * the aggregator's calldata.
 */
export function merchantFeeSwapCalldata(call: MerchantFeeSwapCall): string {
  const data = call.data.replace(/^0x/, '').toLowerCase();
  if (!/^([0-9a-f]{2})*$/.test(data)) {
    throw new Error('the aggregator calldata is not hex');
  }
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return (
    MERCHANT_FEE_ROUTER_SWAP_SELECTOR +
    word(call.tokenIn) +
    word(call.amountIn) +
    word(call.tokenOut) +
    word(call.minOut) +
    word(call.feeWallet) +
    word(call.fee) +
    word(call.recipient) +
    // The bytes start after the eight head words.
    word(8n * 32n) +
    word(BigInt(data.length / 2)) +
    padded
  );
}

/** `aggregator()`: the one contract a router calls with swap calldata. */
export const routerAggregatorCalldata = (): string =>
  MERCHANT_FEE_ROUTER_AGGREGATOR_SELECTOR;

/** The aggregator address in an `aggregator()` answer, or null for anything else. */
export function readAggregator(answer: string): string | null {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(answer)
    ? `0x${answer.slice(-40)}`
    : null;
}

/**
 * The init code of a router for `aggregator`. Run as a creation `eth_call`, a
 * node answers the runtime code such a router has, immutable included, which is
 * what a deployed router's code must equal byte for byte.
 */
export function routerInitCode(aggregator: string): string {
  return MERCHANT_FEE_SWAP_ROUTER_ARTIFACT.bytecode + word(aggregator);
}
