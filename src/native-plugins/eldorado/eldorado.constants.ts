import type { StellarNetwork } from '@/config/configuration';

/**
 * El Dorado, the P2P marketplace behind `/v1/onramp/p2p` and `/v1/offramp/p2p`:
 * people trade stablecoins for local money (bank transfer, PIX, Nequi, Yape,
 * Zelle...) with each other, and the marketplace settles the stablecoin on
 * Arbitrum. Read live on 2026-11-05 from its docs
 * (https://api-testnet.eldorado.io/guides/quick-start, `/guides/widget`,
 * `/guides/sandbox`) and its public API.
 *
 * The published contract never names it (the developer platform's rule: customers
 * do not learn what Cosmos Pay is built on), so errors and the spec call it
 * {@link P2P_MARKETPLACE}. Code and comments keep the real name.
 */
export const P2P_MARKETPLACE = 'P2P marketplace';

/** One environment of the marketplace: its API, its widget and the chain it delivers on. */
export interface EldoradoHost {
  /** REST API. `/currencies`, `/payment-methods` and `/prices` take no credentials. */
  api: string;
  /** Hosted widget; `/exchange` takes the order as query parameters. */
  widget: string;
  /** EIP-155 id of the chain the stablecoin is delivered on. */
  chainId: number;
  /** That chain's name, as this API answers it. */
  chain: string;
  /** The stablecoins traded there: a purchase delivers one, a sale sends one. */
  tokens: readonly EldoradoToken[];
}

export interface EldoradoToken {
  symbol: string;
  /** The token contract on `chain`, EIP-55. */
  address: string;
  decimals: number;
}

/**
 * The marketplace per Stellar network of the calling key (`resolveNetwork`): a
 * `prod` key trades on mainnet, a `dev` key in the sandbox. The sandbox supports
 * only its own test USDT on Arbitrum Sepolia, 18 decimals; any other token or
 * chain fails the order there (its sandbox guide).
 */
export const ELDORADO_HOSTS: Record<StellarNetwork, EldoradoHost> = {
  public: {
    api: 'https://api.eldorado.io/api',
    widget: 'https://widget.eldorado.io',
    chainId: 42161,
    chain: 'arbitrum',
    tokens: [
      // Circle's native USDC on Arbitrum One.
      {
        symbol: 'USDC',
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
      },
      // Tether's USDT0 on Arbitrum One, the token the marketplace settles in.
      {
        symbol: 'USDT',
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        decimals: 6,
      },
    ],
  },
  testnet: {
    api: 'https://api-testnet.eldorado.io/api',
    widget: 'https://widget-testnet.eldorado.io',
    chainId: 421614,
    chain: 'arbitrum-sepolia',
    tokens: [
      {
        symbol: 'USDT',
        address: '0x25f5D414F85b7f4668ADe4E557ef234023208771',
        decimals: 18,
      },
    ],
  },
};

/**
 * How long one network's market (currencies, payment methods, prices) is served
 * from memory, both sides together. Prices move, but a minute is well inside the
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
