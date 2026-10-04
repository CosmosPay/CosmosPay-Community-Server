import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  resolveCrossChainAsset,
  supportedAssets,
} from '@/cross-chain-swaps/cross-chain-assets';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

const STELLAR_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** A slice of the real `GET /v0/tokens` answer (2026-09-30). */
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
    assetId: 'nep141:btc.omft.near',
    decimals: 8,
    blockchain: 'btc',
    symbol: 'BTC',
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

    expect(assets.map((a) => a.chain)).not.toContain('btc');
    expect(new Set(assets.map((a) => a.chain))).toEqual(
      new Set(['stellar', 'solana', 'monad']),
    );
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
});
