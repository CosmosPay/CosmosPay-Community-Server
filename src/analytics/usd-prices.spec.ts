import {
  formatUsd,
  usdPricer,
  valueRows,
  type SettledRow,
} from '@/analytics/usd-prices';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

const STELLAR_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MONAD_USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';

/** 1Click's `GET /v0/tokens`, trimmed to what the pricer reads. */
const TOKENS: NearIntentsToken[] = [
  {
    assetId: 'nep245:xlm',
    blockchain: 'stellar',
    symbol: 'XLM',
    decimals: 7,
    price: 0.25,
  },
  {
    assetId: 'nep245:usdc-stellar',
    blockchain: 'stellar',
    symbol: 'USDC',
    decimals: 7,
    contractAddress: STELLAR_USDC_ISSUER,
    price: 0.9998,
  },
  // Two EURC on Stellar: a symbol nothing can tell apart on a test network.
  {
    assetId: 'nep245:eurc-a',
    blockchain: 'stellar',
    symbol: 'EURC',
    decimals: 7,
    contractAddress: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
    price: 1.08,
  },
  {
    assetId: 'nep245:eurc-b',
    blockchain: 'stellar',
    symbol: 'EURC',
    decimals: 7,
    contractAddress: 'GAQRF3UGHBT6JYQZ7YSUYCIYWAF4T2SAA5237Q5LIQYJOHHFAWDXZ7NM',
    price: 1.07,
  },
  {
    assetId: 'nep141:sol.omft.near',
    blockchain: 'sol',
    symbol: 'SOL',
    decimals: 9,
    price: 150,
  },
  {
    assetId: 'nep141:usdc-sol',
    blockchain: 'sol',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: SOLANA_USDC_MINT,
    price: 1,
  },
  {
    assetId: 'nep141:mon',
    blockchain: 'monad',
    symbol: 'MON',
    decimals: 18,
    price: 0.04,
  },
  {
    assetId: 'nep141:usdc-monad',
    blockchain: 'monad',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: MONAD_USDC,
    price: 1,
  },
  // Listed with no price, or a price that is not one.
  {
    assetId: 'nep141:aqua',
    blockchain: 'stellar',
    symbol: 'AQUA',
    decimals: 7,
    contractAddress: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
  },
  {
    assetId: 'nep141:zero',
    blockchain: 'sol',
    symbol: 'ZERO',
    decimals: 6,
    contractAddress: 'Zero1111111111111111111111111111111111111111',
    price: 0,
  },
  // On a network the payments never settle on.
  {
    assetId: 'nep141:usdc-eth',
    blockchain: 'eth',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    price: 1,
  },
];

describe('usdPricer', () => {
  const mainnet = usdPricer(TOKENS, 'public');
  const testnet = usdPricer(TOKENS, 'testnet');

  it('prices each chain’s coin, however the row names it', () => {
    expect(mainnet({ chain: 'stellar', asset: 'XLM', issuer: null })).toBe(
      0.25,
    );
    expect(mainnet({ chain: 'stellar', asset: 'native', issuer: null })).toBe(
      0.25,
    );
    expect(mainnet({ chain: 'solana', asset: 'SOL', issuer: null })).toBe(150);
    expect(mainnet({ chain: 'monad', asset: 'mon', issuer: null })).toBe(0.04);
  });

  it('prices a mainnet token by its contract, and on Stellar by its code too', () => {
    expect(
      mainnet({ chain: 'stellar', asset: 'USDC', issuer: STELLAR_USDC_ISSUER }),
    ).toBe(0.9998);
    expect(
      mainnet({ chain: 'solana', asset: 'USDC', issuer: SOLANA_USDC_MINT }),
    ).toBe(1);
    // EVM contracts compare in any case: the row keeps EIP-55, 1Click lowercase.
    expect(
      mainnet({
        chain: 'monad',
        asset: 'USDC',
        issuer: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      }),
    ).toBe(1);
    // Another code from USDC's issuer is not USDC.
    expect(
      mainnet({ chain: 'stellar', asset: 'USDX', issuer: STELLAR_USDC_ISSUER }),
    ).toBeNull();
  });

  it('never prices a mainnet token by its name: a USDC from an unknown issuer is not USDC', () => {
    expect(
      mainnet({
        chain: 'stellar',
        asset: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      }),
    ).toBeNull();
    expect(
      mainnet({
        chain: 'solana',
        asset: 'USDC',
        issuer: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      }),
    ).toBeNull();
  });

  it('values a test-network token as the one mainnet token of its symbol', () => {
    // Circle's testnet USDC on Stellar and its devnet mint on Solana.
    expect(
      testnet({
        chain: 'stellar',
        asset: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      }),
    ).toBe(0.9998);
    expect(
      testnet({
        chain: 'solana',
        asset: 'USDC',
        issuer: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      }),
    ).toBe(1);
    // Testnet XLM at XLM's price.
    expect(testnet({ chain: 'stellar', asset: 'XLM', issuer: null })).toBe(
      0.25,
    );
  });

  it('prices nothing it would have to guess', () => {
    // Two EURC listed on Stellar.
    expect(
      testnet({ chain: 'stellar', asset: 'EURC', issuer: 'GTEST' }),
    ).toBeNull();
    // A token named like the coin is not the coin.
    expect(
      testnet({ chain: 'stellar', asset: 'XLM', issuer: 'GFAKE' }),
    ).toBeNull();
    // Listed without a price, or with zero.
    expect(
      mainnet({
        chain: 'stellar',
        asset: 'AQUA',
        issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
      }),
    ).toBeNull();
    expect(
      mainnet({
        chain: 'solana',
        asset: 'ZERO',
        issuer: 'Zero1111111111111111111111111111111111111111',
      }),
    ).toBeNull();
    // Not a chain payments settle on, and a chain with nothing listed.
    expect(mainnet({ chain: 'eth', asset: 'USDC', issuer: null })).toBeNull();
    expect(
      usdPricer([], 'public')({ chain: 'stellar', asset: 'XLM', issuer: null }),
    ).toBeNull();
  });
});

describe('valueRows', () => {
  const pricer = usdPricer(TOKENS, 'public');
  const row = (over: Partial<SettledRow>): SettledRow => ({
    chain: 'stellar',
    asset: 'XLM',
    issuer: null,
    amount: '0',
    count: 1,
    ...over,
  });

  it('adds the priced rows and counts the payments no price covers', () => {
    const value = valueRows(
      [
        row({ amount: '100.0000000', count: 3 }), // 25 USD
        row({
          asset: 'USDC',
          issuer: STELLAR_USDC_ISSUER,
          amount: '50',
          count: 2,
        }), // 49.99 USD
        row({ asset: 'AQUA', issuer: 'GUNPRICED', amount: '1000', count: 4 }),
      ],
      pricer,
    );
    expect(value.usd).toBeCloseTo(74.99, 6);
    expect(value.unpriced).toBe(4);
    expect(value.priced).toBe(5);
    expect(formatUsd(value.usd)).toBe('74.99');
  });

  it('reads a summed numeric whatever the driver hands back, a null sum included', () => {
    const value = valueRows(
      [
        row({
          chain: 'monad',
          asset: 'MON',
          amount: '12.500000000000000001',
          count: 1,
        }),
        row({ amount: null, count: 1 }),
      ],
      pricer,
    );
    expect(formatUsd(value.usd)).toBe('0.50');
    expect(value.priced).toBe(2);
  });

  it('has no USD value without a price list, unless there was nothing to value', () => {
    expect(valueRows([row({ amount: '10', count: 2 })], null)).toEqual({
      usd: null,
      unpriced: 2,
      priced: 0,
    });
    expect(valueRows([], null)).toEqual({ usd: 0, unpriced: 0, priced: 0 });
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(0)).toBe('0.00');
  });
});
