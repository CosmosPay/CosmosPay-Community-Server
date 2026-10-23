import { SWAP_CHAINS } from '@/chains/chains.constants';
import { BITCOIN_ORIGIN_MIN_DEADLINE_SECONDS } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import {
  depositLink,
  depositWindowSeconds,
} from '@/cross-chain-swaps/deposit-request';

const STELLAR_DEPOSIT =
  'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('depositLink', () => {
  it('Stellar: a SEP-7 pay link carrying the memo as MEMO_TEXT', () => {
    const uri = depositLink({
      address: STELLAR_DEPOSIT,
      memo: '188866795',
      amount: '100',
      asset: {
        chain: 'stellar',
        symbol: 'USDC',
        assetId: 'nep245:…',
        decimals: 7,
        contract: USDC_ISSUER,
      },
    });
    expect(uri).toBe(
      `web+stellar:pay?destination=${STELLAR_DEPOSIT}&amount=100` +
        `&asset_code=USDC&asset_issuer=${USDC_ISSUER}` +
        '&memo=188866795&memo_type=MEMO_TEXT',
    );
  });

  it('Stellar: refuses to build a deposit without its memo', () => {
    expect(() =>
      depositLink({
        address: STELLAR_DEPOSIT,
        memo: null,
        amount: '1',
        asset: {
          chain: 'stellar',
          symbol: 'XLM',
          assetId: 'x',
          decimals: 7,
          contract: null,
        },
      }),
    ).toThrow('memo');
  });

  it('Solana: a Solana Pay transfer, spl-token for a token', () => {
    expect(
      depositLink({
        address: 'Dep1111111111111111111111111111111111111111',
        memo: null,
        amount: '2.5',
        asset: {
          chain: 'solana',
          symbol: 'USDC',
          assetId: 'x',
          decimals: 6,
          contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        },
      }),
    ).toBe(
      'solana:Dep1111111111111111111111111111111111111111?amount=2.5' +
        '&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('Monad: EIP-681 on mainnet (143), in base units', () => {
    const deposit = '0x76b4c56085ED136a8744D52bE956396624a730E8';
    expect(
      depositLink({
        address: deposit,
        memo: null,
        amount: '1.5',
        asset: {
          chain: 'monad',
          symbol: 'MON',
          assetId: 'x',
          decimals: 18,
          contract: null,
        },
      }),
    ).toBe(`ethereum:${deposit}@143?value=1500000000000000000`);

    const usdc = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
    expect(
      depositLink({
        address: deposit,
        memo: null,
        amount: '10',
        asset: {
          chain: 'monad',
          symbol: 'USDC',
          assetId: 'x',
          decimals: 6,
          contract: usdc,
        },
      }),
    ).toBe(`ethereum:${usdc}@143/transfer?address=${deposit}&uint256=10000000`);
  });

  it.each([
    ['ethereum', 1],
    ['arbitrum', 42161],
    ['base', 8453],
  ] as const)('%s: EIP-681 on chain %d, ETH in wei', (chain, chainId) => {
    const deposit = '0x76b4c56085ED136a8744D52bE956396624a730E8';
    expect(
      depositLink({
        address: deposit,
        memo: null,
        amount: '0.25',
        asset: {
          chain,
          symbol: 'ETH',
          assetId: 'x',
          decimals: 18,
          contract: null,
        },
      }),
    ).toBe(`ethereum:${deposit}@${chainId}?value=250000000000000000`);
  });

  it('Arbitrum: an ERC-20 deposit is a transfer call on the token, on 42161', () => {
    const deposit = '0x76b4c56085ED136a8744D52bE956396624a730E8';
    const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    expect(
      depositLink({
        address: deposit,
        memo: null,
        amount: '25.5',
        asset: {
          chain: 'arbitrum',
          symbol: 'USDC',
          assetId: 'x',
          decimals: 6,
          contract: usdc,
        },
      }),
    ).toBe(
      `ethereum:${usdc}@42161/transfer?address=${deposit}&uint256=25500000`,
    );
  });

  it('Bitcoin: BIP-21, the amount in decimal BTC', () => {
    const deposit =
      'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
    expect(
      depositLink({
        address: deposit,
        memo: null,
        amount: '0.0015',
        asset: {
          chain: 'bitcoin',
          symbol: 'BTC',
          assetId: 'nep141:btc.omft.near',
          decimals: 8,
          contract: null,
        },
      }),
    ).toBe(`bitcoin:${deposit}?amount=0.0015`);
  });
});

describe('depositWindowSeconds', () => {
  it('raises a Bitcoin-origin window to two hours, and keeps a longer one', () => {
    expect(BITCOIN_ORIGIN_MIN_DEADLINE_SECONDS).toBe(2 * 60 * 60);
    expect(depositWindowSeconds('bitcoin', 1800)).toBe(7200);
    expect(depositWindowSeconds('bitcoin', 3 * 60 * 60)).toBe(10800);
  });

  it.each(SWAP_CHAINS.filter((chain) => chain !== 'bitcoin'))(
    'leaves the configured window alone on %s',
    (chain) => {
      expect(depositWindowSeconds(chain, 1800)).toBe(1800);
    },
  );
});
