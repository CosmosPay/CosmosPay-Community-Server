import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { SWAP_CHAINS, type SwapChain } from '@/chains/chains.constants';
import {
  type CrossChainAsset,
  isSameAsset,
  resolveCrossChainAsset,
  supportedAssets,
} from '@/cross-chain-swaps/cross-chain-assets';
import { NEAR_INTENTS_BLOCKCHAINS } from '@/near-intents/near-intents.constants';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

const STELLAR_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** A slice of the real `GET /v0/tokens` answer (2026-09-30, 2026-10-23). */
const TOKENS: NearIntentsToken[] = [
  {
    assetId:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz',
    decimals: 7,
    blockchain: 'stellar',
    symbol: 'XLM',
  },
  {
    assetId:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu',
    decimals: 7,
    blockchain: 'stellar',
    symbol: 'USDC',
    contractAddress: STELLAR_USDC_ISSUER,
  },
  {
    assetId: 'nep141:sol.omft.near',
    decimals: 9,
    blockchain: 'sol',
    symbol: 'SOL',
  },
  {
    assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    decimals: 6,
    blockchain: 'sol',
    symbol: 'USDC',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  {
    assetId: 'nep141:sol-2dc7b64e5dd3c717fc85abaf51cdcd4b18687f09.omft.near',
    decimals: 6,
    blockchain: 'sol',
    symbol: 'sUSDC',
    contractAddress: '3tMdx4g4grCgqHjELqALfTPnZnG1BLwsPntD3tGREgvp',
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:143_11111111111111111111',
    decimals: 18,
    blockchain: 'monad',
    symbol: 'MON',
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
    decimals: 6,
    blockchain: 'monad',
    symbol: 'USDC',
    contractAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  },
  {
    assetId: 'nep141:eth.omft.near',
    decimals: 18,
    blockchain: 'eth',
    symbol: 'ETH',
  },
  {
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
  {
    assetId: 'nep141:arb.omft.near',
    decimals: 18,
    blockchain: 'arb',
    symbol: 'ETH',
  },
  {
    assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    decimals: 6,
    blockchain: 'arb',
    symbol: 'USDC',
    contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  },
  {
    assetId: 'nep141:base.omft.near',
    decimals: 18,
    blockchain: 'base',
    symbol: 'ETH',
  },
  {
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
  {
    assetId: 'nep141:base-0x1c4a802fd6b591bb71daa01d8335e43719048b24.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'sUSDC',
    contractAddress: '0x1c4a802fd6b591bb71daa01d8335e43719048b24',
  },
  // Listed before native BTC on purpose: the resolver must not take the first
  // contract-less Bitcoin entry it meets.
  {
    assetId: '1cs_v1:btc:native:coin',
    decimals: 8,
    blockchain: 'btc',
    symbol: 'BTC(OMNI)',
  },
  {
    assetId: 'nep141:btc.omft.near',
    decimals: 8,
    blockchain: 'btc',
    symbol: 'BTC',
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
    contractAddress: 'wrap.near',
  },
];

function codeOf(fn: () => unknown): ApiErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : undefined;
  }
  return undefined;
}

describe('supportedAssets', () => {
  it('keeps only the chains this service knows, named as this service names them', () => {
    const assets = supportedAssets(TOKENS);

    expect(assets.map((a) => a.assetId)).not.toContain('nep141:wrap.near');
    expect(assets.map((a) => a.chain)).not.toContain('btc');
    expect(new Set(assets.map((a) => a.chain))).toEqual(new Set(SWAP_CHAINS));
    expect(assets.find((a) => a.symbol === 'SOL')).toEqual({
      chain: 'solana',
      symbol: 'SOL',
      assetId: 'nep141:sol.omft.near',
      decimals: 9,
      contract: null,
    });
  });
});

describe('resolveCrossChainAsset', () => {
  it('finds a native coin by its ticker or by "native"', () => {
    expect(resolveCrossChainAsset(TOKENS, 'stellar', 'xlm').symbol).toBe('XLM');
    expect(resolveCrossChainAsset(TOKENS, 'monad', 'native').symbol).toBe(
      'MON',
    );
  });

  it('finds a token by a symbol listed once on the chain', () => {
    const usdc = resolveCrossChainAsset(TOKENS, 'solana', 'USDC');
    expect(usdc.contract).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(usdc.decimals).toBe(6);
  });

  it('finds a Stellar asset by CODE:ISSUER, and refuses the wrong issuer', () => {
    expect(
      resolveCrossChainAsset(TOKENS, 'stellar', `USDC:${STELLAR_USDC_ISSUER}`)
        .assetId,
    ).toContain('1100_111bzQBB65');
    expect(
      codeOf(() =>
        resolveCrossChainAsset(
          TOKENS,
          'stellar',
          'USDC:GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
        ),
      ),
    ).toBe(ApiErrorCode.AssetUnsupported);
  });

  it('finds an ERC-20 by its address in any case', () => {
    expect(
      resolveCrossChainAsset(
        TOKENS,
        'monad',
        '0x754704BC059F8C67012FED69BC8A327A5AAFB603',
      ).symbol,
    ).toBe('USDC');
  });

  it('does not reach across chains: Solana USDC is not a Monad asset', () => {
    expect(
      codeOf(() =>
        resolveCrossChainAsset(
          TOKENS,
          'monad',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        ),
      ),
    ).toBe(ApiErrorCode.AssetUnsupported);
  });

  it('refuses a symbol two tokens share rather than guess between them', () => {
    const doubled = [
      ...TOKENS,
      {
        assetId: 'nep141:sol-other-usdc.omft.near',
        decimals: 6,
        blockchain: 'sol',
        symbol: 'USDC',
        contractAddress: 'Other1111111111111111111111111111111111111',
      },
    ];
    expect(
      codeOf(() => resolveCrossChainAsset(doubled, 'solana', 'USDC')),
    ).toBe(ApiErrorCode.ValidationFailed);
  });

  it('refuses an asset NEAR Intents does not list', () => {
    expect(
      codeOf(() => resolveCrossChainAsset(TOKENS, 'stellar', 'yXLM')),
    ).toBe(ApiErrorCode.AssetUnsupported);
  });

  it.each(['ethereum', 'arbitrum', 'base'] as const)(
    'finds ETH on %s by its ticker and by "native", and USDC by its symbol',
    (chain) => {
      const eth = resolveCrossChainAsset(TOKENS, chain, 'ETH');
      expect(eth).toMatchObject({ chain, contract: null, decimals: 18 });
      expect(resolveCrossChainAsset(TOKENS, chain, 'native')).toEqual(eth);

      const usdc = resolveCrossChainAsset(TOKENS, chain, 'usdc');
      expect(usdc).toMatchObject({ chain, symbol: 'USDC', decimals: 6 });
      expect(usdc.contract).toMatch(/^0x[0-9a-f]{40}$/);
    },
  );

  it('finds an Arbitrum ERC-20 by its address in any case, and only on Arbitrum', () => {
    const usdc = '0xAF88D065E77C8CC2239327C5EDB3A432268E5831';
    expect(resolveCrossChainAsset(TOKENS, 'arbitrum', usdc).assetId).toBe(
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    );
    expect(codeOf(() => resolveCrossChainAsset(TOKENS, 'base', usdc))).toBe(
      ApiErrorCode.AssetUnsupported,
    );
  });

  it('names native BTC by "BTC" or "native", never BTC(OMNI)', () => {
    for (const spelling of ['BTC', 'btc', 'native']) {
      expect(resolveCrossChainAsset(TOKENS, 'bitcoin', spelling)).toEqual({
        chain: 'bitcoin',
        symbol: 'BTC',
        assetId: 'nep141:btc.omft.near',
        decimals: 8,
        contract: null,
      });
    }
    // Still reachable by its own symbol, which is listed once.
    expect(resolveCrossChainAsset(TOKENS, 'bitcoin', 'BTC(OMNI)').assetId).toBe(
      '1cs_v1:btc:native:coin',
    );
  });

  it('does not trust a native listing whose decimals are not the chain’s', () => {
    const odd: NearIntentsToken[] = [
      { assetId: 'eth-8', decimals: 8, blockchain: 'eth', symbol: 'ETH' },
    ];
    expect(codeOf(() => resolveCrossChainAsset(odd, 'ethereum', 'ETH'))).toBe(
      ApiErrorCode.AssetUnsupported,
    );
  });
});

describe('isSameAsset', () => {
  const on = (chain: SwapChain, ...symbols: string[]): CrossChainAsset[] =>
    symbols.map((symbol) => resolveCrossChainAsset(TOKENS, chain, symbol));

  it('treats two 1Click listings of native BTC as one asset', () => {
    const [btc, omni] = on('bitcoin', 'BTC', 'BTC(OMNI)');
    expect(btc.assetId).not.toBe(omni.assetId);
    expect(isSameAsset(btc, omni)).toBe(true);
  });

  it('tells apart a chain’s coin and its tokens, and one symbol across chains', () => {
    const [arbEth, arbUsdc] = on('arbitrum', 'ETH', 'USDC');
    const [baseEth, baseUsdc] = on('base', 'ETH', 'USDC');
    expect(isSameAsset(arbEth, arbUsdc)).toBe(false);
    expect(isSameAsset(arbUsdc, baseUsdc)).toBe(false);
    expect(isSameAsset(arbEth, baseEth)).toBe(false);
  });

  it('treats one ERC-20 listed twice, in either case, as one asset', () => {
    const [usdc] = on('base', 'USDC');
    expect(
      isSameAsset(usdc, {
        ...usdc,
        assetId: '1cs_v1:base:erc20:other-route',
        contract: `0x${usdc.contract!.slice(2).toUpperCase()}`,
      }),
    ).toBe(true);
  });

  it('keeps two codes from one Stellar issuer apart', () => {
    const [usdc] = on('stellar', 'USDC');
    expect(
      isSameAsset(usdc, { ...usdc, assetId: 'other', symbol: 'EURC' }),
    ).toBe(false);
  });
});

describe('NEAR_INTENTS_BLOCKCHAINS', () => {
  it('names every swap chain, each with its own 1Click blockchain', () => {
    const names = SWAP_CHAINS.map((chain) => NEAR_INTENTS_BLOCKCHAINS[chain]);
    expect(new Set(names).size).toBe(SWAP_CHAINS.length);
    expect(NEAR_INTENTS_BLOCKCHAINS).toMatchObject({
      ethereum: 'eth',
      arbitrum: 'arb',
      base: 'base',
      bitcoin: 'btc',
    });
  });
});
