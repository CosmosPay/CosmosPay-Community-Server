import {
  ELDORADO_HOSTS,
  NATIVE_TOKEN_ADDRESS,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  buildCurrencies,
  buildNetworks,
  chainName,
  estimateAmountOut,
  findToken,
  orderProblem,
  positiveDecimal,
  readChainIds,
  readTokens,
  searchTokens,
  sessionReference,
  tokenLogoUrl,
  tokenUsdPrice,
  widgetUrl,
  type P2pMarket,
  type P2pOrder,
  type P2pToken,
} from '@/native-plugins/eldorado/p2p-market';

// Trimmed copies of the marketplace's public answers on 2026-11-05.
const CURRENCIES = [
  {
    id: 'ARS',
    type: 'FIAT',
    description: { es: 'Pesos Argentinos', en: 'Argentine Pesos' },
  },
  { id: 'BRL', type: 'FIAT', description: { en: 'Brazilian Reais' } },
  { id: 'BOB', type: 'FIAT', description: { en: 'Bolivian Bolivianos' } },
  { id: 'USDT', type: 'CRYPTO', description: { en: 'Tether' } },
];
const METHODS = [
  { id: 'bank_tx_ar', name: 'Bank Transfer (ARS)', currency: 'ARS' },
  { id: 'app_pix_brl', name: 'PIX', currency: 'BRL' },
];
const SELL = {
  ARS: {
    price: '1625.11',
    limits: { in: { min: '5' }, out: { min: '8125.55' } },
  },
  BRL: { price: '4.88', limits: { in: { min: '5' } } },
};
const BUY = {
  ARS: {
    price: '1677.89',
    limits: { in: { min: '8389.45' }, out: { min: '5' } },
  },
  BRL: { price: '6.003', limits: { in: { min: '30.015' } } },
  BOB: { price: '12.0895', limits: { in: { min: '60.4475' } } },
  USDT: { price: '1', limits: { in: { min: '5' } } },
};
/** Arbitrum's list, in the marketplace's order (a few of its 2,768 tokens). */
const ARBITRUM_RAW = [
  {
    address: NATIVE_TOKEN_ADDRESS,
    symbol: 'ETH',
    decimals: 18,
    chainId: '42161',
    logo: 'https://example.invalid/eth.png',
    priceUSD: '2241.32',
  },
  {
    address: '0xdA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    symbol: 'DAI',
    decimals: 18,
    chainId: '42161',
    priceUSD: '1.0025007244',
  },
  {
    address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    symbol: 'USDC',
    decimals: 6,
    chainId: '42161',
    priceUSD: '1.0006651066',
  },
  { address: 'not-an-address', symbol: 'BAD', decimals: 6 },
  {
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    symbol: 'USDT0',
    decimals: 6,
    chainId: '42161',
    priceUSD: '0.997504535',
  },
  // Listed twice: kept once.
  {
    address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    symbol: 'USDT0',
    decimals: 6,
  },
  {
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    symbol: 'ARB',
    decimals: 18,
    chainId: '42161',
  },
  {
    address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    symbol: 'WBTC',
    decimals: 8,
    chainId: '42161',
    priceUSD: '76205.6309137185',
  },
];
const ARBITRUM = readTokens(ARBITRUM_RAW, 42161);
const POLYGON = readTokens(
  [
    {
      address: NATIVE_TOKEN_ADDRESS,
      symbol: 'POL',
      decimals: 18,
      priceUSD: '0.0938535358255971',
    },
  ],
  137,
);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const ORDER: P2pOrder = {
  currency: 'ARS',
  paymentMethod: 'bank_tx_ar',
  chainId: 42161,
  token: USDT0,
  amount: '50000',
  address: ADDRESS,
};

const marketOf = (prices: typeof BUY | typeof SELL): P2pMarket => ({
  currencies: buildCurrencies(CURRENCIES, METHODS, prices),
  networks: buildNetworks(
    new Map([
      [137, POLYGON],
      [42161, ARBITRUM],
    ]),
    42161,
  ),
  defaultToken: ELDORADO_HOSTS.public.defaultToken,
});
const tokenAt = (address: string): P2pToken => findToken(ARBITRUM, address)!;

describe('the P2P market', () => {
  const market = marketOf(BUY);

  it('offers only fiat with a price, a minimum and a payment method', () => {
    // BOB has a price and no method; USDT is not fiat.
    expect(market.currencies.map((c) => c.id)).toEqual(['ARS', 'BRL']);
    expect(market.currencies[0]).toEqual({
      id: 'ARS',
      name: 'Argentine Pesos',
      price: '1677.89',
      minAmount: '8389.45',
      paymentMethods: [{ id: 'bank_tx_ar', name: 'Bank Transfer (ARS)' }],
    });
  });

  it('leaves out a currency whose price or minimum is unusable, and a side not sent', () => {
    const broken = {
      ARS: { price: '0', limits: { in: { min: '10' } } },
      BRL: { price: '6' },
    };
    expect(buildCurrencies(CURRENCIES, METHODS, broken)).toEqual([]);
    expect(buildCurrencies(CURRENCIES, METHODS, undefined)).toEqual([]);
  });

  it('reads only positive decimals', () => {
    expect(positiveDecimal('12.5')).toBe('12.5');
    expect(positiveDecimal(7)).toBe('7');
    expect(positiveDecimal('0')).toBeNull();
    expect(positiveDecimal('-1')).toBeNull();
    expect(positiveDecimal('1e3')).toBeNull();
    expect(positiveDecimal(undefined)).toBeNull();
  });

  describe('chains and tokens', () => {
    it('reads the chain list as numbers, once each', () => {
      expect(readChainIds(['42161', '137', 8453, '42161', 'x', '0'])).toEqual([
        42161, 137, 8453,
      ]);
      expect(readChainIds(undefined)).toEqual([]);
    });

    it('names the chains, and one it does not know by its id', () => {
      expect(chainName(42161)).toBe('Arbitrum');
      expect(chainName(56)).toBe('BNB Chain');
      expect(chainName(999999)).toBe('Chain 999999');
    });

    it('reads a token list EIP-55, each address once, the network’s main assets first', () => {
      // Arbitrum's main assets in their order (ETH, USDT0, USDC, WETH, WBTC, ARB, USDC.e, DAI...).
      expect(ARBITRUM.map((t) => t.symbol)).toEqual([
        'ETH',
        'USDT0',
        'USDC',
        'WBTC',
        'ARB',
        'DAI',
      ]);
      expect(ARBITRUM[2]).toEqual({
        chainId: 42161,
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        symbol: 'USDC',
        decimals: 6,
        priceUsd: '1.0006651066',
        logoUrl: null,
        main: true,
      });
      // The listing's logo as logoUrl (never the raw field), never a token without a valid address.
      expect(Object.keys(ARBITRUM[0])).not.toContain('logo');
      expect(ARBITRUM[0].logoUrl).toBe('https://example.invalid/eth.png');
      expect(ARBITRUM.some((t) => t.symbol === 'BAD')).toBe(false);
    });

    it('puts the tokens nobody uses after the main assets, a known symbol at another address too', () => {
      const tokens = readTokens(
        [
          {
            address: '0x1111111111111111111111111111111111111111',
            symbol: 'XOR',
            decimals: 18,
          },
          // A second "ARB" at another address is not Arbitrum's ARB.
          {
            address: '0x2222222222222222222222222222222222222222',
            symbol: 'ARB',
            decimals: 18,
            priceUSD: '162000000',
          },
          {
            address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
            symbol: 'ARB',
            decimals: 18,
          },
          {
            address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            symbol: 'USDC',
            decimals: 6,
          },
          {
            address: '0x3333333333333333333333333333333333333333',
            symbol: 'RAIL',
            decimals: 18,
          },
        ],
        42161,
      );
      expect(tokens.map((t) => `${t.symbol}:${t.address.slice(0, 6)}`)).toEqual(
        [
          'USDC:0xaf88',
          'ARB:0x912C',
          'XOR:0x1111',
          'ARB:0x2222',
          'RAIL:0x3333',
        ],
      );
      // Only the real ARB is a main asset: the copy may not wear its artwork.
      expect(tokens.map((t) => t.main)).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
    });

    it('orders a network without its own main assets by symbol', () => {
      const tokens = readTokens(
        [
          {
            address: '0x1111111111111111111111111111111111111111',
            symbol: 'XOR',
            decimals: 18,
          },
          {
            address: '0x2222222222222222222222222222222222222222',
            symbol: 'USDC',
            decimals: 6,
          },
          {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'NEW',
            decimals: 18,
          },
          {
            address: '0x3333333333333333333333333333333333333333',
            symbol: 'USDT',
            decimals: 6,
          },
        ],
        999999,
      );
      expect(tokens.map((t) => t.symbol)).toEqual([
        'USDT',
        'USDC',
        'NEW',
        'XOR',
      ]);
    });

    it('passes on an https logo, never CoinGecko’s, CoinMarketCap’s or a plain-http one', () => {
      expect(tokenLogoUrl('https://static.debank.com/image/x/logo.png')).toBe(
        'https://static.debank.com/image/x/logo.png',
      );
      expect(
        tokenLogoUrl('https://assets.coingecko.com/coins/images/1/large/x.png'),
      ).toBeNull();
      expect(
        tokenLogoUrl('https://coin-images.coingecko.com/x.png'),
      ).toBeNull();
      expect(
        tokenLogoUrl(
          'https://s2.coinmarketcap.com/static/img/coins/64x64/1.png',
        ),
      ).toBeNull();
      expect(tokenLogoUrl('http://example.org/x.png')).toBeNull();
      expect(tokenLogoUrl('javascript:alert(1)')).toBeNull();
      expect(
        tokenLogoUrl(`https://example.org/${'a'.repeat(600)}.png`),
      ).toBeNull();
      expect(tokenLogoUrl(42)).toBeNull();
    });

    it('prices a USD stablecoin the marketplace did not price at 1, nothing else', () => {
      expect(tokenUsdPrice('USDT', undefined)).toBe('1');
      expect(tokenUsdPrice('USDT', '0.998')).toBe('0.998');
      expect(tokenUsdPrice('ARB', undefined)).toBeNull();
      expect(
        findToken(ARBITRUM, '0x912CE59144191C1204E64559FE8253a0e49E6548'),
      ).toMatchObject({ symbol: 'ARB', priceUsd: null });
    });

    it('offers the chains with tokens, the default first, then the longest lists', () => {
      const networks = buildNetworks(
        new Map([
          [137, POLYGON],
          [81457, []],
          [1, [...ARBITRUM, ...ARBITRUM]],
          [42161, ARBITRUM],
        ]),
        42161,
      );
      expect(networks).toEqual([
        { chainId: 42161, name: 'Arbitrum', tokenCount: 6 },
        { chainId: 1, name: 'Ethereum', tokenCount: 12 },
        { chainId: 137, name: 'Polygon', tokenCount: 1 },
      ]);
    });

    it('searches by symbol fragment or exact address, any case', () => {
      expect(searchTokens(ARBITRUM, 'usd').map((t) => t.symbol)).toEqual([
        'USDT0',
        'USDC',
      ]);
      expect(
        searchTokens(ARBITRUM, USDT0.toLowerCase()).map((t) => t.symbol),
      ).toEqual(['USDT0']);
      expect(searchTokens(ARBITRUM, '  ')).toHaveLength(ARBITRUM.length);
    });
  });

  it('accepts an order that fits and says why one does not', () => {
    expect(orderProblem(market, ARBITRUM, ORDER, 'buy')).toBeNull();
    expect(
      orderProblem(market, ARBITRUM, { ...ORDER, currency: 'BOB' }, 'buy'),
    ).toMatch(/currency BOB cannot be bought/);
    expect(
      orderProblem(
        market,
        ARBITRUM,
        { ...ORDER, paymentMethod: 'app_pix_brl' },
        'buy',
      ),
    ).toMatch(/does not pay in ARS/);
    expect(
      orderProblem(market, null, { ...ORDER, chainId: 81457 }, 'buy'),
    ).toBe('chainId 81457 is not offered (offered: 42161, 137)');
    expect(
      orderProblem(market, ARBITRUM, { ...ORDER, token: ADDRESS }, 'buy'),
    ).toBe(
      `token ${ADDRESS} is not offered on chain 42161; list them with GET /v1/onramp/p2p/tokens?chainId=42161`,
    );
    expect(
      orderProblem(market, ARBITRUM, { ...ORDER, amount: '50000.123' }, 'buy'),
    ).toBe('amount is local money: at most two decimals');
    expect(
      orderProblem(market, ARBITRUM, { ...ORDER, amount: '8000' }, 'buy'),
    ).toMatch(/below the minimum of 8389.45 ARS/);
  });

  it('buys any listed token on any listed chain, the native coin included', () => {
    const order = { ...ORDER, chainId: 137, token: NATIVE_TOKEN_ADDRESS };
    expect(orderProblem(market, POLYGON, order, 'buy')).toBeNull();
  });

  it('estimates down to the cent, or to six decimals below one token', () => {
    // 50000 / 1677.89 / 0.997504535 = 29.873...
    expect(
      estimateAmountOut('50000', '1677.89', tokenAt(USDT0).priceUsd, 'buy'),
    ).toBe('29.87');
    // A stablecoin priced at 1: 100 / 6.003 = 16.658...
    expect(estimateAmountOut('100', '6.003', '1', 'buy')).toBe('16.65');
    // 50000 / 1677.89 / 2241.32 = 0.0132956...
    expect(estimateAmountOut('50000', '1677.89', '2241.32', 'buy')).toBe(
      '0.013295',
    );
    expect(estimateAmountOut('50000', '1677.89', null, 'buy')).toBeNull();
  });

  describe('the sell side', () => {
    const sell = marketOf(SELL);
    const SALE: P2pOrder = { ...ORDER, amount: '50' };

    it('reads its own prices, with the minimum in USD', () => {
      expect(sell.currencies.map((c) => c.id)).toEqual(['ARS', 'BRL']);
      expect(sell.currencies[0]).toMatchObject({
        price: '1625.11',
        minAmount: '5',
      });
    });

    it('checks a sale in its own words', () => {
      expect(orderProblem(sell, ARBITRUM, SALE, 'sell')).toBeNull();
      expect(
        orderProblem(sell, ARBITRUM, { ...SALE, currency: 'BOB' }, 'sell'),
      ).toMatch(/tokens cannot be sold for BOB/);
      expect(
        orderProblem(
          sell,
          ARBITRUM,
          { ...SALE, paymentMethod: 'app_pix_brl' },
          'sell',
        ),
      ).toMatch(/does not pay out ARS/);
      expect(
        orderProblem(sell, ARBITRUM, { ...SALE, token: ADDRESS }, 'sell'),
      ).toMatch(
        /list them with GET \/v1\/offramp\/p2p\/tokens\?chainId=42161$/,
      );
    });

    it('takes up to the token’s decimals', () => {
      expect(
        orderProblem(sell, ARBITRUM, { ...SALE, amount: '50.123456' }, 'sell'),
      ).toBeNull();
      expect(
        orderProblem(sell, ARBITRUM, { ...SALE, amount: '50.1234567' }, 'sell'),
      ).toBe('amount has more decimals than USDT0 (6)');
    });

    it('holds a sale to the minimum in USD where the token has a price', () => {
      // 4.99 USDT0 at 0.9975 USD is under 5 USD: about 5.02 USDT0 is needed.
      expect(
        orderProblem(sell, ARBITRUM, { ...SALE, amount: '4.99' }, 'sell'),
      ).toBe('amount is below the minimum of 5 USD (about 5.02 USDT0)');
      const eth = { ...SALE, token: NATIVE_TOKEN_ADDRESS, amount: '0.002' };
      expect(orderProblem(sell, ARBITRUM, eth, 'sell')).toBe(
        'amount is below the minimum of 5 USD (about 0.002231 ETH)',
      );
      // ARB has no USD price: the window checks it.
      const arb = {
        ...SALE,
        token: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        amount: '0.01',
      };
      expect(orderProblem(sell, ARBITRUM, arb, 'sell')).toBeNull();
    });

    it('estimates the local money a sale pays, down to the cent', () => {
      // 50 * 1 * 1625.11 = 81255.5
      expect(estimateAmountOut('50', '1625.11', '1', 'sell')).toBe('81255.50');
      // 0.57 * 1 lands a hair under 0.57 in floating point.
      expect(estimateAmountOut('0.57', '1', '1', 'sell')).toBe('0.57');
      // 0.01 ETH at 2241.32 USD, 1625.11 ARS per USD = 36423.915...
      expect(estimateAmountOut('0.01', '1625.11', '2241.32', 'sell')).toBe(
        '36423.91',
      );
      expect(estimateAmountOut('1', '1625.11', null, 'sell')).toBeNull();
    });

    it('opens the widget as a SELL without fixing the wallet', () => {
      const url = new URL(
        widgetUrl(
          ELDORADO_HOSTS.public,
          SALE,
          tokenAt(USDT0),
          'cp-4',
          null,
          'sell',
        ),
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        operation: 'SELL',
        token: USDT0,
        chain: '42161',
        currency: 'ARS',
        paymentMethod: 'bank_tx_ar',
        amount: '50',
        externalReferenceId: 'cp-4',
      });
    });
  });

  it('references a session with letters, digits and hyphens only', () => {
    expect(sessionReference('ab12_cd/34-ef')).toBe('cp-ab12cd34-ef');
  });

  it('opens the widget with the recipient fixed and the order filled in', () => {
    const url = new URL(
      widgetUrl(
        ELDORADO_HOSTS.public,
        ORDER,
        tokenAt(USDT0),
        'cp-1',
        null,
        'buy',
      ),
    );
    expect(url.origin + url.pathname).toBe(
      'https://widget.eldorado.io/exchange',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      operation: 'BUY',
      token: USDT0,
      chain: '42161',
      currency: 'ARS',
      paymentMethod: 'bank_tx_ar',
      amount: '50000',
      address: ADDRESS,
      externalReferenceId: 'cp-1',
    });
  });

  it('opens the widget on the token’s own chain, with the integrator ids when configured', () => {
    const url = new URL(
      widgetUrl(
        ELDORADO_HOSTS.public,
        { ...ORDER, chainId: 137, token: NATIVE_TOKEN_ADDRESS },
        POLYGON[0],
        'cp-2',
        { clientId: 'c-1', referralId: 'r-1' },
        'buy',
      ),
    );
    expect(url.searchParams.get('chain')).toBe('137');
    expect(url.searchParams.get('token')).toBe(NATIVE_TOKEN_ADDRESS);
    expect(url.searchParams.get('clientId')).toBe('c-1');
    expect(url.searchParams.get('referralId')).toBe('r-1');
  });
});
