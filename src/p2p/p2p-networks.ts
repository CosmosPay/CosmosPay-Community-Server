import type { StellarNetwork } from '@/config/configuration';
import { MONAD_CHAIN_IDS } from '@/chains/chains.constants';
import { CROSS_CHAIN_EVM_CHAIN_IDS } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import {
  SANDBOX_NETWORKS,
  type SandboxEvmNetwork,
} from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * The EVM networks the P2P market can run on, one `P2PMarket` deployment per
 * network and tier. The ids are the ones the rest of the service already uses
 * for these networks (`CROSS_CHAIN_NETWORKS`, `SANDBOX_NETWORKS`), so a client
 * names Base as `base` everywhere.
 *
 * A network is offered on a tier only when the operator configured a contract
 * there (`P2P_MARKET_CONTRACTS_*`) and the deployment checks out on-chain
 * (`P2pDeployments`); this table only says what the network IS.
 */
export const P2P_NETWORK_IDS = [
  'eth',
  'base',
  'arb',
  'op',
  'pol',
  'bsc',
  'avax',
  'monad',
  'gnosis',
  'bera',
  'xlayer',
  'plasma',
  'hood',
] as const;
export type P2pNetworkId = (typeof P2P_NETWORK_IDS)[number];

export function isP2pNetworkId(value: unknown): value is P2pNetworkId {
  return (
    typeof value === 'string' &&
    (P2P_NETWORK_IDS as readonly string[]).includes(value)
  );
}

/** A stablecoin the market trades on one network and tier. */
export interface P2pToken {
  symbol: string;
  /** EIP-55. */
  address: string;
  decimals: number;
}

/** One network on one tier. */
export interface P2pTierNetwork {
  /**
   * EIP-155 id: mainnet ids from `CROSS_CHAIN_EVM_CHAIN_IDS` / `MONAD_CHAIN_IDS`
   * (checked against chainlist and `eth_chainId`), test networks from
   * `SANDBOX_NETWORKS` (checked the same way). The client refuses a node that
   * answers another.
   */
  chainId: number;
  /** The tokens listed here, by address. cUSD is added from `SANDBOX_CUSD_ADDRESSES`. */
  tokens: readonly P2pToken[];
  /** cUSD where no official test USDC exists: its address is the sandbox's. */
  sandboxCusd: boolean;
  /** A public node for a test network; null on mainnet, where the operator names one. */
  defaultRpcUrl: string | null;
  /**
   * Blocks a log must be under before the indexer acts on it. Ethereum and the
   * networks whose reorgs have gone deeper get more; networks with fast
   * finality fewer.
   */
  confirmations: number;
  /** Blocks one `eth_getLogs` may span on the public nodes (the tightest cap seen). */
  logBlockRange: number;
}

export interface P2pNetwork {
  id: P2pNetworkId;
  /** The network's own name, for pickers. */
  name: string;
  tiers: Record<StellarNetwork, P2pTierNetwork | null>;
}

/**
 * Mainnet stablecoins, by address. The same addresses as the token lists the
 * repo already carries for these chains, and each one answered `symbol()` and
 * `decimals()` on its own chain on 2026-11-19 (`npm run p2p:verify-tokens`
 * checks them again). USDT on BNB Chain and USDC there have 18 decimals.
 */
const MAINNET_TOKENS: Partial<Record<P2pNetworkId, readonly P2pToken[]>> = {
  eth: [
    usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    token('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
  ],
  base: [
    usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    token('USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
  ],
  arb: [
    usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
    token('USDT0', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
  ],
  op: [
    usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    token('USDT0', '0x01bFF41798a0BcF287b996046Ca68b395DbC1071', 6),
  ],
  pol: [
    usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    token('USDT0', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
  ],
  bsc: [
    token('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
    token('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
  ],
  avax: [
    usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
    token('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
  ],
  monad: [
    usdc('0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
    token('USDT0', '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', 6),
  ],
};

/** Mainnet confirmations and log caps; test networks use the defaults below. */
const MAINNET_DEPTH: Partial<
  Record<P2pNetworkId, { confirmations: number; logBlockRange: number }>
> = {
  eth: { confirmations: 12, logBlockRange: 500 },
  base: { confirmations: 10, logBlockRange: 500 },
  arb: { confirmations: 20, logBlockRange: 500 },
  op: { confirmations: 10, logBlockRange: 500 },
  pol: { confirmations: 32, logBlockRange: 500 },
  bsc: { confirmations: 15, logBlockRange: 500 },
  avax: { confirmations: 2, logBlockRange: 500 },
  monad: { confirmations: 3, logBlockRange: 100 },
};

const TESTNET_CONFIRMATIONS = 2;
const TESTNET_LOG_BLOCK_RANGE = 500;
/** Monad's public test node caps `eth_getLogs` at 100 blocks. */
const MONAD_LOG_BLOCK_RANGE = 100;

function token(symbol: string, address: string, decimals: number): P2pToken {
  return { symbol, address, decimals };
}

function usdc(address: string): P2pToken {
  return token('USDC', address, 6);
}

const NAMES: Record<P2pNetworkId, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  op: 'Optimism',
  pol: 'Polygon',
  bsc: 'BNB Chain',
  avax: 'Avalanche',
  monad: 'Monad',
  gnosis: 'Gnosis',
  bera: 'Berachain',
  xlayer: 'X Layer',
  plasma: 'Plasma',
  hood: 'Robinhood Chain',
};

function mainnetChainId(id: P2pNetworkId): number | null {
  if (id === 'monad') return MONAD_CHAIN_IDS.public;
  return (
    (CROSS_CHAIN_EVM_CHAIN_IDS as Partial<Record<string, number>>)[id] ?? null
  );
}

function mainnetTier(id: P2pNetworkId): P2pTierNetwork | null {
  const chainId = mainnetChainId(id);
  const tokens = MAINNET_TOKENS[id];
  const depth = MAINNET_DEPTH[id];
  if (chainId === null || !tokens || !depth) return null;
  return {
    chainId,
    tokens,
    sandboxCusd: false,
    defaultRpcUrl: null,
    ...depth,
  };
}

/** The test network the sandbox already settles on, with its test stablecoin. */
function testnetTier(id: P2pNetworkId): P2pTierNetwork | null {
  const entry = SANDBOX_NETWORKS[id];
  if (entry.kind !== 'evm') return null;
  const evm: SandboxEvmNetwork = entry;
  const coin = evm.stablecoin;
  return {
    chainId: evm.chainId,
    tokens: coin.contract
      ? [token(coin.symbol, coin.contract, coin.decimals)]
      : [],
    sandboxCusd: coin.issuer === 'cusd',
    defaultRpcUrl: evm.defaultRpcUrl,
    confirmations: TESTNET_CONFIRMATIONS,
    logBlockRange:
      id === 'monad' ? MONAD_LOG_BLOCK_RANGE : TESTNET_LOG_BLOCK_RANGE,
  };
}

/**
 * Every network, by id. A `Record`, so a new id does not compile until it
 * says what it is on each tier.
 */
export const P2P_NETWORKS: Record<P2pNetworkId, P2pNetwork> =
  Object.fromEntries(
    P2P_NETWORK_IDS.map((id) => [
      id,
      {
        id,
        name: NAMES[id],
        tiers: { public: mainnetTier(id), testnet: testnetTier(id) },
      },
    ]),
  ) as Record<P2pNetworkId, P2pNetwork>;
