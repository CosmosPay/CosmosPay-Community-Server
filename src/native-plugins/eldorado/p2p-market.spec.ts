import { ELDORADO_HOSTS } from '@/native-plugins/eldorado/eldorado.constants';
import {
  buildMarket,
  estimateAmountOut,
  orderProblem,
  positiveDecimal,
  sessionReference,
  widgetUrl,
  type P2pOrder,
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
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const ORDER: P2pOrder = {
  currency: 'ARS',
  paymentMethod: 'bank_tx_ar',
  token: 'USDC',
  amount: '50000',
  address: ADDRESS,
};

describe('the P2P market', () => {
  const market = buildMarket(ELDORADO_HOSTS.public, CURRENCIES, METHODS, BUY);

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

  it('delivers on Arbitrum on mainnet and on Arbitrum Sepolia in the sandbox', () => {
    expect(market.chainId).toBe(42161);
    expect(market.tokens.map((t) => t.symbol)).toEqual(['USDC', 'USDT']);
    const sandbox = buildMarket(
      ELDORADO_HOSTS.testnet,
      CURRENCIES,
      METHODS,
      BUY,
    );
    expect(sandbox.chainId).toBe(421614);
    expect(sandbox.tokens).toEqual([
      {
        symbol: 'USDT',
        address: '0x25f5D414F85b7f4668ADe4E557ef234023208771',
        decimals: 18,
      },
    ]);
  });

  it('leaves out a currency whose price or minimum is unusable', () => {
    const broken = {
      ARS: { price: '0', limits: { in: { min: '10' } } },
      BRL: { price: '6' },
    };
    expect(
      buildMarket(ELDORADO_HOSTS.public, CURRENCIES, METHODS, broken)
        .currencies,
    ).toEqual([]);
  });

  it('reads only positive decimals', () => {
    expect(positiveDecimal('12.5')).toBe('12.5');
    expect(positiveDecimal(7)).toBe('7');
    expect(positiveDecimal('0')).toBeNull();
    expect(positiveDecimal('-1')).toBeNull();
    expect(positiveDecimal('1e3')).toBeNull();
    expect(positiveDecimal(undefined)).toBeNull();
  });

  it('accepts an order that fits and says why one does not', () => {
    expect(orderProblem(market, ORDER, 'buy')).toBeNull();
    expect(orderProblem(market, { ...ORDER, currency: 'BOB' }, 'buy')).toMatch(
      /currency BOB cannot be bought/,
    );
    expect(
      orderProblem(market, { ...ORDER, paymentMethod: 'app_pix_brl' }, 'buy'),
    ).toMatch(/does not pay in ARS/);
    expect(orderProblem(market, { ...ORDER, token: 'DAI' }, 'buy')).toMatch(
      /token DAI is not delivered/,
    );
    expect(orderProblem(market, { ...ORDER, amount: '8000' }, 'buy')).toMatch(
      /below the minimum of 8389.45 ARS/,
    );
  });

  it('estimates down to the cent, never above what the price gives', () => {
    // 50000 / 1677.89 = 29.799...
    expect(estimateAmountOut('50000', '1677.89', 'buy')).toBe('29.79');
    expect(estimateAmountOut('100', '6.003', 'buy')).toBe('16.65');
  });

  describe('the sell side', () => {
    const sell = buildMarket(ELDORADO_HOSTS.public, CURRENCIES, METHODS, SELL);
    const SALE: P2pOrder = { ...ORDER, token: 'USDT', amount: '50' };

    it('reads its own prices, with the minimum in the stablecoin', () => {
      expect(sell.currencies.map((c) => c.id)).toEqual(['ARS', 'BRL']);
      expect(sell.currencies[0]).toMatchObject({
        price: '1625.11',
        minAmount: '5',
      });
    });

    it('offers nothing when the marketplace sends no sell side', () => {
      expect(
        buildMarket(ELDORADO_HOSTS.public, CURRENCIES, METHODS, undefined)
          .currencies,
      ).toEqual([]);
    });

    it('checks a sale in its own words, the minimum in the token', () => {
      expect(orderProblem(sell, SALE, 'sell')).toBeNull();
      expect(orderProblem(sell, { ...SALE, currency: 'BOB' }, 'sell')).toMatch(
        /stablecoins cannot be sold for BOB/,
      );
      expect(
        orderProblem(sell, { ...SALE, paymentMethod: 'app_pix_brl' }, 'sell'),
      ).toMatch(/does not pay out ARS/);
      expect(orderProblem(sell, { ...SALE, token: 'DAI' }, 'sell')).toMatch(
        /token DAI cannot be sold on this network/,
      );
      expect(orderProblem(sell, { ...SALE, amount: '4.99' }, 'sell')).toBe(
        'amount is below the minimum of 5 USDT',
      );
    });

    it('estimates the local money a sale pays, down to the cent', () => {
      // 50 * 1625.11 = 81255.5
      expect(estimateAmountOut('50', '1625.11', 'sell')).toBe('81255.50');
      // 0.57 * 1 lands a hair under 0.57 in floating point.
      expect(estimateAmountOut('0.57', '1', 'sell')).toBe('0.57');
      expect(estimateAmountOut('10.33', '4.88', 'sell')).toBe('50.41');
    });

    it('opens the widget as a SELL without fixing the wallet', () => {
      const url = new URL(
        widgetUrl(ELDORADO_HOSTS.public, SALE, 'cp-4', null, 'sell'),
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        operation: 'SELL',
        token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
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
      widgetUrl(ELDORADO_HOSTS.public, ORDER, 'cp-1', null, 'buy'),
    );
    expect(url.origin + url.pathname).toBe(
      'https://widget.eldorado.io/exchange',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      operation: 'BUY',
      token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      chain: '42161',
      currency: 'ARS',
      paymentMethod: 'bank_tx_ar',
      amount: '50000',
      address: ADDRESS,
      externalReferenceId: 'cp-1',
    });
  });

  it('carries the integrator ids when the deployment has them', () => {
    const url = new URL(
      widgetUrl(
        ELDORADO_HOSTS.testnet,
        { ...ORDER, token: 'USDT' },
        'cp-2',
        { clientId: 'c-1', referralId: 'r-1' },
        'buy',
      ),
    );
    expect(url.origin).toBe('https://widget-testnet.eldorado.io');
    expect(url.searchParams.get('chain')).toBe('421614');
    expect(url.searchParams.get('clientId')).toBe('c-1');
    expect(url.searchParams.get('referralId')).toBe('r-1');
  });

  it('refuses to build a widget for a token the network does not deliver', () => {
    expect(() =>
      widgetUrl(ELDORADO_HOSTS.testnet, ORDER, 'cp-3', null, 'buy'),
    ).toThrow(/USDC is not traded/);
  });
});
