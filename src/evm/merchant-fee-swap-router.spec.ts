import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  MERCHANT_FEE_ROUTER_AGGREGATOR_SELECTOR,
  MERCHANT_FEE_ROUTER_SWAP_SELECTOR,
} from '@/evm/evm.constants';
import { MERCHANT_FEE_SWAP_ROUTER_ARTIFACT } from '@/evm/merchant-fee-swap-router.artifact';
import {
  merchantFeeSwapCalldata,
  readAggregator,
  routerInitCode,
} from '@/evm/merchant-fee-swap-router';

const selector = (signature: string) =>
  `0x${Buffer.from(keccak_256(Buffer.from(signature)))
    .toString('hex')
    .slice(0, 8)}`;

const AGGREGATOR = '0xb3e6778480b2E488385E8205eA05E20060B813cb';

describe('merchant fee swap router calls', () => {
  it('uses the selectors of the contract functions', () => {
    expect(MERCHANT_FEE_ROUTER_SWAP_SELECTOR).toBe(
      selector(
        'swap(address,uint256,address,uint256,address,uint256,address,bytes)',
      ),
    );
    expect(MERCHANT_FEE_ROUTER_AGGREGATOR_SELECTOR).toBe(
      selector('aggregator()'),
    );
  });

  it('encodes the static words, then the offset, length and padded calldata', () => {
    const data = merchantFeeSwapCalldata({
      tokenIn: '0x0000000000000000000000000000000000000000',
      amountIn: 1000n,
      tokenOut: '0x754704bc059F8C67012FEd69BC8A327a5aafb603',
      minOut: 990n,
      feeWallet: '0x62ee1b8d1efdf8f73c78db87b888406b194e266a',
      fee: 20n,
      recipient: '0x00000000000000000000000000000000000000aa',
      data: '0xCE1E7030ff',
    });
    const words = data.slice(10).match(/.{64}/g)!;
    expect(words).toHaveLength(10);
    expect(BigInt(`0x${words[1]}`)).toBe(1000n);
    expect(words[2].endsWith('754704bc059f8c67012fed69bc8a327a5aafb603')).toBe(
      true,
    );
    expect(BigInt(`0x${words[7]}`)).toBe(256n); // after the 8 head words
    expect(BigInt(`0x${words[8]}`)).toBe(5n);
    expect(words[9]).toBe('ce1e7030ff'.padEnd(64, '0'));
    // Calldata of a whole number of words needs no padding word.
    const exact = merchantFeeSwapCalldata({
      tokenIn: AGGREGATOR,
      amountIn: 1n,
      tokenOut: AGGREGATOR,
      minOut: 1n,
      feeWallet: AGGREGATOR,
      fee: 1n,
      recipient: AGGREGATOR,
      data: `0x${'ab'.repeat(32)}`,
    });
    expect((exact.length - 10) / 64).toBe(10);
  });

  it('refuses calldata that is not hex', () => {
    expect(() =>
      merchantFeeSwapCalldata({
        tokenIn: AGGREGATOR,
        amountIn: 1n,
        tokenOut: AGGREGATOR,
        minOut: 1n,
        feeWallet: AGGREGATOR,
        fee: 1n,
        recipient: AGGREGATOR,
        data: '0xabc',
      }),
    ).toThrow(/not hex/);
  });

  it('reads the aggregator from an aggregator() answer only', () => {
    const word = `0x${AGGREGATOR.slice(2).toLowerCase().padStart(64, '0')}`;
    expect(readAggregator(word)).toBe(AGGREGATOR.toLowerCase());
    expect(readAggregator('0x')).toBeNull();
    expect(readAggregator(`0x${'1'.repeat(64)}`)).toBeNull();
  });

  it('builds the init code from the artifact and the aggregator', () => {
    expect(routerInitCode(AGGREGATOR)).toBe(
      MERCHANT_FEE_SWAP_ROUTER_ARTIFACT.bytecode +
        AGGREGATOR.slice(2).toLowerCase().padStart(64, '0'),
    );
  });
});
