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
 * Each network's main assets, the ones a token list starts with, in this order,
 * before every other token in the marketplace's order (the user, 2026-11-05: the
 * network's main assets first, "and at the end the others nobody uses"). A list
 * runs to thousands of entries (Ethereum lists 6,778), most of them unused, and
 * some reuse a known symbol at another address with a nonsense price (an "ARB"
 * at 162 million USD on BNB Chain), so the main assets are matched by address,
 * never by symbol. In each: the network's own coin (the zero address) where it
 * has one, its USD stablecoins, the wrapped coin, bitcoin, the network's token,
 * the other stablecoins, DeFi blue chips and liquid staked ether. Resolved on
 * 2026-11-05 against each chain's `/chains/{id}/tokens`, with their prices
 * checked; an address a list drops is simply absent there.
 */
export const P2P_MAIN_TOKENS: Readonly<Record<number, readonly string[]>> = {
  // Arbitrum: ETH, USDT0, USDC, WETH, WBTC, ARB, USDC.e, DAI, cbBTC, USDe, PYUSD, LINK, UNI, AAVE, GMX, wstETH, weETH, rETH.
  42161: [
    '0x0000000000000000000000000000000000000000',
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    '0x912CE59144191C1204E64559FE8253a0e49E6548',
    '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    '0x46850aD61C2B7d64d08c9C754F45254596696984',
    '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0',
    '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
    '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    '0x5979D7b546E38E414F7E9822514be443A4800529',
    '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe',
    '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8',
  ],
  // Ethereum: ETH, USDT, USDC, WETH, WBTC, cbBTC, DAI, USDS, USDe, PYUSD, FDUSD, EURC, LINK, UNI, AAVE, LDO, wstETH, weETH, rETH, cbETH.
  1: [
    '0x0000000000000000000000000000000000000000',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
    '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
    '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32',
    '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee',
    '0xae78736Cd615f374D3085123A210448E74Fc6393',
    '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704',
  ],
  // Base: ETH, USDC, USDT, WETH, cbBTC, WBTC, AERO, USDbC, DAI, USDS, USDe, EURC, LINK, AAVE, wstETH, weETH, cbETH, rETH.
  8453: [
    '0x0000000000000000000000000000000000000000',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    '0x4200000000000000000000000000000000000006',
    '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc',
    '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
    '0x63706e401c06ac8513145b7687A14804d17f814b',
    '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
    '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
    '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
  ],
  // Optimism: ETH, USDT0, USDC, WETH, WBTC, OP, USDT, USDC.e, DAI, EURC, WLD, LINK, UNI, AAVE, wstETH, weETH, rETH.
  10: [
    '0x0000000000000000000000000000000000000000',
    '0x01bFF41798a0BcF287b996046Ca68b395DbC1071',
    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    '0x4200000000000000000000000000000000000006',
    '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    '0x4200000000000000000000000000000000000042',
    '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    '0xDCB612005417Dc906fF72c87DF732e5a90D49e11',
    '0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1',
    '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6',
    '0x6fd9d7AD17242c41f7131d257212c54A0e816691',
    '0x76FB31fb4af56892A25e32cFC43De717950c9278',
    '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
    '0x5A7fACB970D094B6C7FF1df0eA68D99E6e73CBFF',
    '0x9Bcef72be871e61ED4fBbc7630889beE758eb81D',
  ],
  // Polygon: POL, USDT, USDC, WPOL, WETH, WBTC, USDC.e, DAI, LINK, UNI, AAVE, LDO, CRV, wstETH.
  137: [
    '0x0000000000000000000000000000000000000000',
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    '0xb33EaAd8d922B1083446DC23f610c2567fB5180f',
    '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
    '0xC3C7d422809852031b44ab29EEC9F1EfF2A58756',
    '0x172370d5Cd63279eFa6d502DAB29171933a610AF',
    '0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD',
  ],
  // BNB Chain: BNB, USDT, USDC, WBNB, BTCB, WETH, FDUSD, USDe, DAI, Cake, WBTC, LINK, UNI, AAVE, weETH.
  56: [
    '0x0000000000000000000000000000000000000000',
    '0x55d398326f99059fF775485246999027B3197955',
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
    '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1',
    '0xfb6115445Bff7b52FeB98650C87f44907E58f802',
    '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
  ],
  // Avalanche: AVAX, USDt, USDC, WAVAX, BTC.b, WBTC, WETH.e, USDC.e, USDe, EURC, JOE, GMX, weETH.
  43114: [
    '0x0000000000000000000000000000000000000000',
    '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    '0x152b9d0FdC40C096757F570A51E494bd4b943E50',
    '0x50b7545627a5162F82A992c33b87aDc75187B218',
    '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664',
    '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD',
    '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
    '0x62edc0692BD897D2295872a9FFCac5425011c661',
    '0xA3D68b74bF0528fdD07263c60d6488749044914b',
  ],
  // Unichain: ETH, USDC, USD₮0, WETH, WBTC, DAI, wstETH, weETH, rETH.
  130: [
    '0x0000000000000000000000000000000000000000',
    '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    '0x9151434b16b9763660705744891fA906F660EcC5',
    '0x4200000000000000000000000000000000000006',
    '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    '0x20CAb320A855b39F724131C69424240519573f81',
    '0xc02fE7317D4eb8753a02c35fe019786854A92001',
    '0x7DCC39B4d1C53CB31e1aBc0e358b43987FEF80f7',
    '0x94Cac393f3444cEf63a651FfC18497E7e8bd036a',
  ],
  // World Chain: ETH, USDC, WETH, WBTC, WLD.
  480: [
    '0x0000000000000000000000000000000000000000',
    '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1',
    '0x4200000000000000000000000000000000000006',
    '0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3',
    '0x2cFc85d8E48F8EAB294be644d9E25C3030863003',
  ],
  // Celo: CELO, USD₮, USDC, USDm, EURm, WETH, BRLm, COPm.
  42220: [
    '0x471EcE3750Da237f93B8E339c536989b8978a438',
    '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    '0x765DE816845861e75A25fCA122bb6898B8B1282a',
    '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73',
    '0xD221812de1BD094f35587EE8E174B07B6167D9Af',
    '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787',
    '0x8A567e2aE79CA692Bd748aB832081C45de4041eA',
  ],
  // Arbitrum Sepolia: USDT.
  421614: ['0x25f5D414F85b7f4668ADe4E557ef234023208771'],
};

/**
 * The order for a network without its own list in {@link P2P_MAIN_TOKENS} (one
 * the marketplace adds later), by symbol: the stablecoins the P2P leg settles in
 * (USDT0, USDT, USDC), then the chain's own coin (`native`, the zero address),
 * then what people hold most.
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
