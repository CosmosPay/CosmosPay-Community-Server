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
    expect(orderProblem(market, ORDER)).toBeNull();
    expect(orderProblem(market, { ...ORDER, currency: 'BOB' })).toMatch(
      /currency BOB cannot be bought/,
    );
    expect(
      orderProblem(market, { ...ORDER, paymentMethod: 'app_pix_brl' }),
    ).toMatch(/does not pay in ARS/);
    expect(orderProblem(market, { ...ORDER, token: 'DAI' })).toMatch(
      /token DAI is not delivered/,
    );
    expect(orderProblem(market, { ...ORDER, amount: '8000' })).toMatch(
      /below the minimum of 8389.45 ARS/,
    );
  });

  it('estimates down to the cent, never above what the price gives', () => {
    // 50000 / 1677.89 = 29.799...
    expect(estimateAmountOut('50000', '1677.89')).toBe('29.79');
    expect(estimateAmountOut('100', '6.003')).toBe('16.65');
  });

  it('references a session with letters, digits and hyphens only', () => {
    expect(sessionReference('ab12_cd/34-ef')).toBe('cp-ab12cd34-ef');
  });

  it('opens the widget with the recipient fixed and the order filled in', () => {
    const url = new URL(widgetUrl(ELDORADO_HOSTS.public, ORDER, 'cp-1', null));
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
      widgetUrl(ELDORADO_HOSTS.testnet, { ...ORDER, token: 'USDT' }, 'cp-2', {
        clientId: 'c-1',
        referralId: 'r-1',
      }),
    );
    expect(url.origin).toBe('https://widget-testnet.eldorado.io');
    expect(url.searchParams.get('chain')).toBe('421614');
    expect(url.searchParams.get('clientId')).toBe('c-1');
    expect(url.searchParams.get('referralId')).toBe('r-1');
  });

  it('refuses to build a widget for a token the network does not deliver', () => {
    expect(() =>
      widgetUrl(ELDORADO_HOSTS.testnet, ORDER, 'cp-3', null),
    ).toThrow(/USDC is not delivered/);
  });
});
