import type { StellarNetwork } from '@/config/configuration';

/**
 * El Dorado, the P2P marketplace behind `/v1/onramp/p2p` and `/v1/offramp/p2p`:
 * people trade USD stablecoins for local money (bank transfer, PIX, Nequi, Yape,
 * Zelle...) with each other, and the widget swaps and bridges that leg to any
 * token it lists on any chain it lists (`/chains`, `/chains/{chainId}/tokens`).
 * Read live on 2026-11-05 from its docs
 * (https://api-testnet.eldorado.io/guides/quick-start, `/guides/widget`,
 * `/guides/sandbox`, the spec at `/api/openapi`) and its public API.
 *
 * The published contract never names it (the developer platform's rule: customers
 * do not learn what Cosmos Pay is built on), so errors and the spec call it
 * {@link P2P_MARKETPLACE}. Code and comments keep the real name.
 */
export const P2P_MARKETPLACE = 'P2P marketplace';

/** One environment of the marketplace: its API, its widget and the token an order starts from. */
export interface EldoradoHost {
  /** REST API. `/currencies`, `/payment-methods`, `/prices`, `/chains` and the token lists take no credentials. */
  api: string;
  /** Hosted widget; `/exchange` takes the order as query parameters. */
  widget: string;
  /** The token a form preselects: the stablecoin the marketplace settles in, on its chain. */
  defaultToken: EldoradoToken;
}

export interface EldoradoToken {
  /** EIP-155 id of the chain the token lives on. */
  chainId: number;
  /** The token contract on that chain, EIP-55. */
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * The marketplace per Stellar network of the calling key (`resolveNetwork`): a
 * `prod` key trades on mainnet (eleven chains on 2026-11-05), a `dev` key in the
 * sandbox, which lists one chain, Arbitrum Sepolia, and one token there, its own
 * test USDT (18 decimals, no USD price).
 */
export const ELDORADO_HOSTS: Record<StellarNetwork, EldoradoHost> = {
  public: {
    api: 'https://api.eldorado.io/api',
    widget: 'https://widget.eldorado.io',
    // Tether's USDT0 on Arbitrum One, the token the marketplace settles in.
    defaultToken: {
      chainId: 42161,
      address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      symbol: 'USDT0',
      decimals: 6,
    },
  },
  testnet: {
    api: 'https://api-testnet.eldorado.io/api',
    widget: 'https://widget-testnet.eldorado.io',
    defaultToken: {
      chainId: 421614,
      address: '0x25f5D414F85b7f4668ADe4E557ef234023208771',
      symbol: 'USDT',
      decimals: 18,
    },
  },
};

/**
 * The chains' names as this API answers them, by EIP-155 id: the eleven the
 * marketplace lists on mainnet and the sandbox's one. A chain it adds later is
 * `Chain <id>` until it gets an entry here.
 */
export const ELDORADO_CHAIN_NAMES: Readonly<Record<number, string>> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  130: 'Unichain',
  137: 'Polygon',
  480: 'World Chain',
  8453: 'Base',
  42161: 'Arbitrum',
  42220: 'Celo',
  43114: 'Avalanche',
  81457: 'Blast',
  421614: 'Arbitrum Sepolia',
};

/** The address the marketplace lists a chain's own coin under (ETH, POL, BNB...). */
export const NATIVE_TOKEN_ADDRESS =
  '0x0000000000000000000000000000000000000000';

/**
 * The tokens a list starts with, in this order where the chain has them, before
 * the rest in the marketplace's order: the stablecoins the P2P leg settles in
 * (USDT0, USDT, USDC), then the chain's own coin (`native`, the zero address),
 * then what people hold most. A token list runs to thousands of entries
 * (Ethereum lists 6,778), and a picker should open on what is bought.
 */
export const P2P_TOKEN_PRIORITY: readonly string[] = [
  'USDT0',
  'USDT',
  'USDC',
  'native',
  'WETH',
  'WBTC',
  'DAI',
  'USDC.e',
];

/**
 * USD stablecoins, valued at 1 USD when the marketplace sends no price for one
 * (the sandbox's test USDT has none), so their estimates and minimums still work.
 */
export const P2P_USD_STABLECOINS: readonly string[] = [
  'USDT',
  'USDT0',
  'USDC',
  'USDC.e',
  'DAI',
  'USDS',
];

/** Page size of `GET .../tokens`: a picker's first screen, and the most one call answers. */
export const P2P_TOKENS_DEFAULT_TAKE = 100;
export const P2P_TOKENS_MAX_TAKE = 200;

/**
 * How long one chain's token list is served from memory. The lists change when
 * the marketplace adds a token, not with the market, and the largest is about
 * 1.2 MB (Ethereum), so an hour keeps a dashboard from fetching it on every
 * form. A list that failed to load is not kept: the next market read asks again.
 */
export const ELDORADO_TOKENS_TTL_MS = 60 * 60 * 1000;

/**
 * How long one network's market (currencies, payment methods, prices and the
 * chain list) is served from memory, both sides together. Prices move, but a minute is well inside the
 * quote's own life, and every dashboard form and wallet opening reads it.
 */
export const ELDORADO_MARKET_TTL_MS = 60 * 1000;

/**
 * The widget reads a fixed recipient from `address` (a 0x account) and treats
 * the buyer as connected with it, so nobody is asked to connect a wallet.
 * Undocumented: found in the widget's bundle on 2026-11-05
 * (`useExternalWalletAddress`, validated there against /^0x[a-fA-F0-9]{40}$/).
 * Without it the buyer connects any wallet and the stablecoin lands there, so a
 * purchase is never built without it. A sale never carries it: the seller has to
 * connect the wallet that signs the transfer.
 */
export const ELDORADO_ADDRESS_PARAM = 'address';

/**
 * Prefix of the `externalReferenceId` a session puts in its widget URL, followed
 * by a random UUID. The marketplace allows letters, digits and hyphens only.
 */
export const P2P_SESSION_REFERENCE_PREFIX = 'cp';

/**
 * A firm quote spends a call on the integrator ids every tenant of this
 * deployment shares; a dashboard re-quoting as the amount changes stays well
 * under it, a pricing loop does not. Purchases and sales count apart.
 */
export const P2P_QUOTE_RATE_LIMIT = {
  name: 'onramp-p2p:quote',
  limit: 30,
  windowMs: 60 * 1000,
};
export const P2P_SELL_QUOTE_RATE_LIMIT = {
  name: 'offramp-p2p:quote',
  limit: 30,
  windowMs: 60 * 1000,
};

/** A session is a stored row per call: opening a purchase or a sale a few times a minute is plenty. */
export const P2P_SESSION_RATE_LIMIT = {
  name: 'onramp-p2p:session',
  limit: 20,
  windowMs: 60 * 1000,
};
export const P2P_SELL_SESSION_RATE_LIMIT = {
  name: 'offramp-p2p:session',
  limit: 20,
  windowMs: 60 * 1000,
};
