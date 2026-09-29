import type { StellarNetwork } from '@/config/configuration';
import { MONAD_CHAIN_IDS } from '@/chains/chains.constants';

/** The EVM chains this service speaks. Monad today; one entry per chain. */
export const EVM_CHAINS = ['monad'] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];

/** Each EVM chain's EIP-155 ids, per network tier. */
export const EVM_CHAIN_IDS: Record<EvmChain, Record<StellarNetwork, number>> = {
  monad: MONAD_CHAIN_IDS,
};

/** Display name, for the errors a caller sees ("Monad RPC is unreachable"). */
export const EVM_PROVIDER_NAMES: Record<EvmChain, string> = {
  monad: 'Monad',
};

/** `keccak256("Transfer(address,address,uint256)")` — the ERC-20 transfer log. */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** `transfer(address,uint256)` — how an ERC-20 payment's calldata begins. */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

/** `decimals()` selector. */
export const ERC20_DECIMALS_SELECTOR = '0x313ce567';

/** The URI scheme of an EIP-681 payment request. */
export const EIP681_SCHEME = 'ethereum:';

/**
 * `eth_getLogs` calls one observer tick may spend on one intent. With the
 * public RPC's 100-block cap and Monad's ~0.4 s blocks that is ~200 s of chain
 * per tick: enough to keep up at the default 15 s interval and to catch up a
 * backlog over a few ticks without letting one intent own the sweep.
 */
export const EVM_LOG_SCAN_MAX_CALLS = 5;
