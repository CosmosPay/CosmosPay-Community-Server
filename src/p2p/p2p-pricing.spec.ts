import {
  bondFor,
  feesOn,
  fiatFor,
  formatUnits,
  parseDecimalUnits,
  priceTrade,
  tokensFor,
} from '@/p2p/p2p-pricing';

const PRICE = (v: string) => parseDecimalUnits(v, 6)!;

describe('P2P pricing', () => {
  it('parses and formats decimals within their places', () => {
    expect(parseDecimalUnits('1250.5', 2)).toBe(125050n);
    expect(parseDecimalUnits('1250', 2)).toBe(125000n);
    expect(parseDecimalUnits('1250.555', 2)).toBeNull();
    expect(parseDecimalUnits('-1', 2)).toBeNull();
    expect(parseDecimalUnits('1e3', 2)).toBeNull();
    expect(parseDecimalUnits('15000', 0)).toBe(15000n);
    expect(parseDecimalUnits('15000.5', 0)).toBeNull();
    expect(formatUnits(125050n, 2)).toBe('1250.50');
    expect(formatUnits(15000n, 0)).toBe('15000');
    expect(formatUnits(1_000_000n, 6)).toBe('1.000000');
  });

  it('converts between local money and tokens in both roundings', () => {
    // 1250.50 ARS per USDC (6 decimals).
    expect(fiatFor(1_000_000n, PRICE('1250.5'), 6, 2, 'down')).toBe(125050n);
    expect(fiatFor(1n, PRICE('1250.5'), 6, 2, 'down')).toBe(0n);
    expect(fiatFor(1n, PRICE('1250.5'), 6, 2, 'up')).toBe(1n);
    expect(tokensFor(125050n, PRICE('1250.5'), 6, 2, 'down')).toBe(1_000_000n);
    // 18-decimal tokens (BNB Chain).
    expect(tokensFor(100n, PRICE('1'), 18, 2, 'down')).toBe(10n ** 18n);
  });

  it('takes fees as the contract does, rounded down', () => {
    expect(feesOn(100_000_000n, 100, 50)).toEqual({
      protocolFee: 1_000_000n,
      integratorFee: 500_000n,
      net: 98_500_000n,
    });
    expect(feesOn(99n, 100, 0)).toEqual({
      protocolFee: 0n,
      integratorFee: 0n,
      net: 99n,
    });
  });

  it('prices a purchase from local money: gross tokens for the money, net after fees', () => {
    const priced = priceTrade({
      side: 'BUY',
      priceUnits: PRICE('1000'),
      tokenDecimals: 6,
      currencyDecimals: 2,
      protocolFeeBps: 100,
      integratorFeeBps: 0,
      fiatUnits: 10_000_00n,
    });
    expect(priced).toEqual({
      fiatUnits: 10_000_00n,
      grossTokens: 10_000_000n,
      protocolFee: 100_000n,
      integratorFee: 0n,
      netTokens: 9_900_000n,
    });
  });

  it('prices a purchase from tokens: the money rounded up, never short', () => {
    const priced = priceTrade({
      side: 'BUY',
      priceUnits: PRICE('1000.333333'),
      tokenDecimals: 6,
      currencyDecimals: 2,
      protocolFeeBps: 0,
      integratorFeeBps: 0,
      tokenUnits: 1_000_000n,
    })!;
    expect(priced.fiatUnits).toBe(100034n);
  });

  it('prices a sale from local money: the smallest gross whose net is worth it', () => {
    const priced = priceTrade({
      side: 'SELL',
      priceUnits: PRICE('1000'),
      tokenDecimals: 6,
      currencyDecimals: 2,
      protocolFeeBps: 100,
      integratorFeeBps: 50,
      fiatUnits: 10_000_00n,
    })!;
    expect(priced.netTokens).toBeGreaterThanOrEqual(10_000_000n);
    expect(feesOn(priced.grossTokens - 1n, 100, 50).net).toBeLessThan(
      10_000_000n,
    );
    expect(priced.fiatUnits).toBe(10_000_00n);
  });

  it('prices a sale from tokens: paid for the net amount, rounded down', () => {
    const priced = priceTrade({
      side: 'SELL',
      priceUnits: PRICE('1000'),
      tokenDecimals: 6,
      currencyDecimals: 2,
      protocolFeeBps: 100,
      integratorFeeBps: 0,
      tokenUnits: 10_000_000n,
    })!;
    expect(priced.netTokens).toBe(9_900_000n);
    expect(priced.fiatUnits).toBe(9_900_00n);
  });

  it('answers null for amounts that round to nothing', () => {
    expect(
      priceTrade({
        side: 'BUY',
        priceUnits: PRICE('1000'),
        tokenDecimals: 6,
        currencyDecimals: 2,
        protocolFeeBps: 0,
        integratorFeeBps: 0,
        fiatUnits: 0n,
      }),
    ).toBeNull();
    expect(
      priceTrade({
        side: 'BUY',
        priceUnits: 0n,
        tokenDecimals: 6,
        currencyDecimals: 2,
        protocolFeeBps: 0,
        integratorFeeBps: 0,
        fiatUnits: 100n,
      }),
    ).toBeNull();
  });

  it('takes a tenth of the amount as the bond', () => {
    expect(bondFor(200_000_000n, 1_000n)).toBe(20_000_000n);
    expect(bondFor(9n, 1_000n)).toBe(0n);
  });
});
