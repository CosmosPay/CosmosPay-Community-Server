import {
  isBitcoinAddress,
  normalizeBitcoinAddress,
} from '@/chains/bitcoin-address';
import {
  CHAIN_ADDRESS_RULES,
  type ChainAddressRule,
  isEvmAddress,
  toChecksumAddress,
} from '@/chains/chain-address';
import type { SwapChain } from '@/chains/chains.constants';

/** An EVM chain's rule: 0x + 40 hex, stored EIP-55 — Monad's, under another name. */
function evmAddressRule(name: string): ChainAddressRule {
  return {
    isValid: isEvmAddress,
    expected: `a valid ${name} (EVM) address (0x + 40 hex)`,
    normalize: toChecksumAddress,
  };
}

/**
 * {@link CHAIN_ADDRESS_RULES} over the cross-chain swap vocabulary: the three
 * payment chains unchanged, plus Ethereum, Arbitrum and Base (EVM, as Monad)
 * and Bitcoin mainnet. Only the cross-chain swap module reads it, so an
 * Ethereum or Bitcoin address never validates for a payment intent, an alias
 * or a wallet sign-in. A `Record<SwapChain, …>`, so a chain added to
 * `SWAP_CHAINS` does not compile until it says what its addresses are.
 */
export const SWAP_CHAIN_ADDRESS_RULES: Record<SwapChain, ChainAddressRule> = {
  ...CHAIN_ADDRESS_RULES,
  ethereum: evmAddressRule('Ethereum'),
  arbitrum: evmAddressRule('Arbitrum'),
  base: evmAddressRule('Base'),
  // bech32 / bech32m segwit or base58check legacy, checksum verified.
  bitcoin: {
    isValid: isBitcoinAddress,
    expected:
      'a valid Bitcoin mainnet address (bc1q..., bc1p..., 1... or 3...)',
    normalize: normalizeBitcoinAddress,
  },
};

export function normalizeSwapAddress(
  chain: SwapChain,
  address: string,
): string {
  return SWAP_CHAIN_ADDRESS_RULES[chain].normalize(address);
}
