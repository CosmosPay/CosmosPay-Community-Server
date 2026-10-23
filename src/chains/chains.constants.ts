import type { StellarNetwork } from '@/config/configuration';

/**
 * The chains this service settles payments on, signs wallets in with and
 * resolves aliases to. Stellar is the original and the default: a request that
 * names no chain means Stellar, so every integration written before the others
 * existed keeps working unchanged.
 *
 * Each chain is served on two network tiers, picked by the caller's API key
 * exactly as for Stellar — a `prod` key reaches the chain's mainnet, a `dev` key
 * its test network — and stored in the same `network` column (`public` /
 * `testnet`) so filters and analytics read one vocabulary for all three.
 */
export const CHAINS = ['stellar', 'solana', 'monad'] as const;
export type Chain = (typeof CHAINS)[number];

/** What a request that names no chain means. */
export const DEFAULT_CHAIN: Chain = 'stellar';

/** The chains that are not Stellar — the ones added beside it. */
export type OtherChain = Exclude<Chain, 'stellar'>;

export function isChain(value: unknown): value is Chain {
  return (
    typeof value === 'string' && (CHAINS as readonly string[]).includes(value)
  );
}

/** The EVM chains a cross-chain swap reaches beside Monad. */
export const SWAP_EVM_CHAINS = ['ethereum', 'arbitrum', 'base'] as const;
export type SwapEvmChain = (typeof SWAP_EVM_CHAINS)[number];

/**
 * The chains a cross-chain swap (`/v1/cross-chain-swaps`, settled by NEAR
 * Intents) may start or end on: every {@link Chain}, plus Ethereum, Arbitrum,
 * Base and Bitcoin.
 *
 * A vocabulary of its own, on purpose. `CHAINS` drives payment intents,
 * aliases, wallet sign-in and same-chain swaps, and each of those needs an RPC
 * client, a verifier or a signature scheme per chain it names. A cross-chain
 * swap needs none of that — 1Click watches the deposit address and its solvers
 * pay the output — only an address rule, a deposit link and 1Click's name for
 * the chain. Adding these four to `CHAINS` would make every other module accept
 * chains it cannot serve; keeping them here means only the cross-chain module
 * does, and its `Record<SwapChain, …>` tables do not compile until a new chain
 * has an entry in each.
 */
export const SWAP_CHAINS = [...CHAINS, ...SWAP_EVM_CHAINS, 'bitcoin'] as const;
export type SwapChain = (typeof SWAP_CHAINS)[number];

export function isSwapChain(value: unknown): value is SwapChain {
  return (
    typeof value === 'string' &&
    (SWAP_CHAINS as readonly string[]).includes(value)
  );
}

/** How each chain's own documentation names each network tier. */
export const CHAIN_NETWORK_NAMES: Record<
  Chain,
  Record<StellarNetwork, string>
> = {
  stellar: { public: 'public', testnet: 'testnet' },
  solana: { public: 'mainnet-beta', testnet: 'devnet' },
  monad: { public: 'mainnet', testnet: 'testnet' },
};

/** The native coin's ticker, per chain — what `assetCode` may say for it. */
export const NATIVE_ASSET_CODES: Record<Chain, string> = {
  stellar: 'XLM',
  solana: 'SOL',
  monad: 'MON',
};

/**
 * Decimal places of each chain's native coin: stroops, lamports, wei. A token
 * carries its own (an SPL mint's `decimals`, an ERC-20's `decimals()`), read
 * from the chain when an intent is created.
 */
export const NATIVE_DECIMALS: Record<Chain, number> = {
  stellar: 7,
  solana: 9,
  monad: 18,
};

/** {@link NATIVE_ASSET_CODES} over every swap chain: ETH on the three EVM chains. */
export const SWAP_NATIVE_ASSET_CODES: Record<SwapChain, string> = {
  ...NATIVE_ASSET_CODES,
  ethereum: 'ETH',
  arbitrum: 'ETH',
  base: 'ETH',
  bitcoin: 'BTC',
};

/**
 * {@link NATIVE_DECIMALS} over every swap chain: wei on the EVM chains,
 * satoshis on Bitcoin. A deposit link in base units (EIP-681's `value`) is
 * written with these, so a 1Click listing of a native coin that disagrees is
 * not trusted — it would ask the payer for a different amount than the quote.
 */
export const SWAP_NATIVE_DECIMALS: Record<SwapChain, number> = {
  ...NATIVE_DECIMALS,
  ethereum: 18,
  arbitrum: 18,
  base: 18,
  bitcoin: 8,
};

/**
 * EIP-155 chain ids of the swap-only EVM chains, mainnet only — NEAR Intents
 * has no test network. Not configurable, for the reason {@link MONAD_CHAIN_IDS}
 * is not: the id in an EIP-681 link is what makes a wallet pay on Arbitrum
 * rather than on whichever chain it has open, and an Arbitrum deposit sent on
 * Ethereum is money 1Click never sees.
 */
export const SWAP_EVM_CHAIN_IDS: Record<SwapEvmChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
};

/**
 * Bitcoin mainnet's address parameters: the bech32 human-readable part of a
 * segwit address (BIP-173), and the base58check version bytes of a legacy
 * P2PKH (`1…`) and P2SH (`3…`) address. Testnet's (`tb`, `0x6f`, `0xc4`) are
 * refused, as every swap is on mainnet.
 */
export const BITCOIN_BECH32_HRP = 'bc';
export const BITCOIN_P2PKH_VERSION = 0x00;
export const BITCOIN_P2SH_VERSION = 0x05;

/** BIP-21's URI scheme. */
export const BIP21_SCHEME = 'bitcoin:';

/**
 * Monad's EIP-155 chain ids. Not configurable, on purpose: the id goes into
 * every EIP-681 link and is what makes a wallet pay on Monad rather than on
 * whichever chain it has open, so it must be the chain's, not an operator's
 * typo. The RPC client checks `eth_chainId` against it before trusting a node
 * (verified against rpc.monad.xyz → 0x8f and testnet-rpc.monad.xyz → 0x279f).
 */
export const MONAD_CHAIN_IDS: Record<StellarNetwork, number> = {
  public: 143,
  testnet: 10143,
};

/**
 * Solana genesis hashes, per tier. The RPC client compares `getGenesisHash`
 * with these before trusting a node, so an operator who points the mainnet URL
 * at devnet gets a 503 instead of payment links that settle on the wrong
 * cluster.
 */
export const SOLANA_GENESIS_HASHES: Record<StellarNetwork, string> = {
  public: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  testnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};

/**
 * Most decimals a token may declare and still be accepted. 18 is the ERC-20
 * convention and above every SPL mint in use; a contract that answers more is
 * either broken or hostile, and amounts in it cannot be written down sanely.
 */
export const MAX_TOKEN_DECIMALS = 18;

/**
 * Largest JSON-RPC body read from a node. A `getTransaction` with its logs and
 * token balances is tens of kilobytes; a page of `eth_getLogs` over one block
 * range is similar. Anything near this is a node misbehaving, and reading it
 * whole would put an operator's memory at the mercy of the RPC provider.
 */
export const CHAIN_RPC_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
