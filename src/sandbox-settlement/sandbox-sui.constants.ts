import type { SandboxNetworkCommon } from '@/sandbox-settlement/sandbox-settlement.constants';

/** Sui's test network, as the sandbox settles on it. */
export interface SandboxSuiNetwork extends SandboxNetworkCommon {
  kind: 'sui';
  /**
   * The network's chain identifier as its GraphQL service answers it: the
   * base58 digest of the genesis checkpoint. The client compares it before
   * trusting a node, so a URL pointed at mainnet (or devnet) is refused.
   */
  chainIdentifier: string;
}

/**
 * Sui testnet's genesis checkpoint digest. Read from
 * graphql.testnet.sui.io (`chainIdentifier`) on 2026-11-17; its first four
 * bytes are `4c78adac`, the testnet id the JSON-RPC answered before it was
 * retired on public nodes.
 */
export const SUI_TESTNET_CHAIN_IDENTIFIER =
  '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';

/**
 * Circle's test USDC on Sui testnet: the coin type from Circle's published
 * list (developers.circle.com, "USDC contract addresses"), checked on-chain on
 * 2026-11-17 (`coinMetadata`: symbol USDC, 6 decimals).
 */
export const SUI_TESTNET_USDC =
  '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

/** The gas coin's type. */
export const SUI_COIN_TYPE = '0x2::sui::SUI';

export const SUI_TESTNET: SandboxSuiNetwork = {
  kind: 'sui',
  testnetName: 'Sui Testnet',
  // Public fullnodes no longer serve JSON-RPC: the sandbox speaks GraphQL.
  defaultRpcUrl: 'https://graphql.testnet.sui.io/graphql',
  explorerTx: 'https://suiscan.xyz/testnet/tx/',
  chainIdentifier: SUI_TESTNET_CHAIN_IDENTIFIER,
  stablecoin: {
    symbol: 'USDC',
    decimals: 6,
    issuer: 'circle',
    contract: SUI_TESTNET_USDC,
  },
};

/** SLIP-44 coin type of Sui: deposit keys live under m/44'/784'/7007'/a'/b'. */
export const SUI_COIN_TYPE_INDEX = 784;

/**
 * Gas budget of a sandbox USDC transfer, in MIST. A merge, a split and a
 * transfer cost about 1M MIST of computation at the reference gas price (1000
 * on 2026-11-17) plus about 2-3M MIST of storage, mostly rebated; 20M (0.02
 * SUI) leaves room for a gas price several times higher. Only what is used is
 * charged.
 */
export const SUI_TRANSFER_GAS_BUDGET = 20_000_000n;

/**
 * At most this many coin objects go into one transfer, for the stablecoin and
 * for gas alike (Sui allows 256 gas coins; a treasury needing more than this
 * many to cover one payout is fragmented, and the transfer waits).
 */
export const SUI_MAX_COINS_PER_TRANSFER = 50;
