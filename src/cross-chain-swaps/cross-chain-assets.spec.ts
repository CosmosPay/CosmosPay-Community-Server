import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  resolveCrossChainAsset,
  supportedAssets,
  tradableAssets,
} from '@/cross-chain-swaps/cross-chain-assets';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

const STELLAR_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

/** A slice of the real `GET /v0/tokens` answer (2026-09-30 and 2026-10-25). */
const TOKENS: NearIntentsToken[] = [
  {
    assetId:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz',
    decimals: 7,
    blockchain: 'stellar',
    symbol: 'XLM',
    price: 0.2257,
  },
  {
    assetId:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu',
    decimals: 7,
    blockchain: 'stellar',
    symbol: 'USDC',
    contractAddress: STELLAR_USDC_ISSUER,
    price: 0.999538,
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
    price: 2341.04,
  },
  {
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
    contractAddress: ETH_USDC,
    price: 0.999538,
  },
  {
    assetId: 'nep141:btc.omft.near',
    decimals: 8,
    blockchain: 'btc',
    symbol: 'BTC',
    price: 80484,
  },
  // 1Click lists a second contract-less BTC; `native` and `BTC` must not pick it.
  {
    assetId: '1cs_v1:btc:native:coin',
    decimals: 8,
    blockchain: 'btc',
    symbol: 'BTC(OMNI)',
    price: 80484,
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:1117_',
    decimals: 9,
    blockchain: 'ton',
    symbol: 'GRAM',
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
    contractAddress: 'wrap.near',
  },
  // Blockchains this service does not reach: dropped.
  {
    assetId: 'nep141:qtc.omft.near',
    decimals: 12,
    blockchain: 'qtc',
    symbol: 'QTC',
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:36900_11111111111111111111',
    decimals: 18,
    blockchain: 'adi',
    symbol: 'ADI',
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
  it('lists every network this service reaches, named as this service names them', () => {
    const assets = supportedAssets(TOKENS);

    expect(new Set(assets.map((a) => a.chain))).toEqual(
      new Set(['stellar', 'solana', 'monad', 'eth', 'btc', 'ton', 'near']),
    );
    expect(assets.find((a) => a.symbol === 'SOL')).toEqual({
      chain: 'solana',
      chainName: 'Solana',
      symbol: 'SOL',
      assetId: 'nep141:sol.omft.near',
      decimals: 9,
      contract: null,
      priceUsd: null,
    });
    expect(assets.find((a) => a.assetId === 'nep141:btc.omft.near')).toEqual({
      chain: 'btc',
      chainName: 'Bitcoin',
      symbol: 'BTC',
      assetId: 'nep141:btc.omft.near',
      decimals: 8,
      contract: null,
      priceUsd: 80484,
    });
  });

  it('drops the blockchains it cannot validate (qtc, adi)', () => {
    const symbols = supportedAssets(TOKENS).map((a) => a.symbol);
    expect(symbols).not.toContain('QTC');
    expect(symbols).not.toContain('ADI');
  });

  it('passes 1Click’s price on as an indicative priceUsd, null when it has none', () => {
    const assets = supportedAssets([
      ...TOKENS,
      {
        assetId: 'nep141:broken.near',
        decimals: 6,
        blockchain: 'near',
        symbol: 'NAN',
        contractAddress: 'broken.near',
        price: Number.NaN,
      },
    ]);
    const price = (symbol: string) =>
      assets.find((a) => a.symbol === symbol)?.priceUsd;
    expect(price('ETH')).toBe(2341.04);
    expect(price('XLM')).toBe(0.2257);
    expect(price('MON')).toBeNull();
    expect(price('NAN')).toBeNull();
  });
});

describe('tradableAssets', () => {
  const RETIRING = [
    {
      assetId: 'nep141:xpl-old.near',
      decimals: 18,
      blockchain: 'eth',
      symbol: 'XPL_(DEPRECATED)',
      contractAddress: '0x0000000000000000000000000000000000000abc',
      price: 0.07,
    },
    {
      assetId: 'nep141:usdt0-old.near',
      decimals: 6,
      blockchain: 'eth',
      symbol: 'USDT0(DEPRECATED)',
      contractAddress: '0x0000000000000000000000000000000000000def',
      price: 1,
    },
  ];

  it('lists only what 1Click still trades: priced, and not tagged deprecated', () => {
    const symbols = tradableAssets([...TOKENS, ...RETIRING]).map(
      (a) => a.symbol,
    );
    // Priced in the fixture.
    expect(symbols).toEqual(
      expect.arrayContaining(['XLM', 'USDC', 'ETH', 'BTC', 'BTC(OMNI)']),
    );
    // No price (1Click quotes none of these), or retiring.
    for (const gone of ['SOL', 'MON', 'GRAM', 'wNEAR', 'XPL_(DEPRECATED)']) {
      expect(symbols).not.toContain(gone);
    }
    expect(symbols).not.toContain('USDT0(DEPRECATED)');
    expect(
      tradableAssets([...TOKENS, ...RETIRING]).every(
        (a) => a.priceUsd !== null && a.priceUsd > 0,
      ),
    ).toBe(true);
  });

  it('refuses a deprecated token by name or contract, and still resolves a priceless one', () => {
    const tokens = [...TOKENS, ...RETIRING];
    expect(
      codeOf(() => resolveCrossChainAsset(tokens, 'eth', 'XPL_(DEPRECATED)')),
    ).toBe(ApiErrorCode.AssetUnsupported);
    expect(
      codeOf(() =>
        resolveCrossChainAsset(
          tokens,
          'eth',
          '0x0000000000000000000000000000000000000def',
        ),
      ),
    ).toBe(ApiErrorCode.AssetUnsupported);
    // 1Click's own refusal says why a priceless token cannot be quoted.
    expect(resolveCrossChainAsset(tokens, 'solana', 'SOL').symbol).toBe('SOL');
  });
});

describe('resolveCrossChainAsset', () => {
  it('finds a native coin by its ticker or by "native"', () => {
    expect(resolveCrossChainAsset(TOKENS, 'stellar', 'xlm').symbol).toBe('XLM');
    expect(resolveCrossChainAsset(TOKENS, 'monad', 'native').symbol).toBe(
      'MON',
    );
    expect(resolveCrossChainAsset(TOKENS, 'eth', 'native').assetId).toBe(
      'nep141:eth.omft.near',
    );
    expect(resolveCrossChainAsset(TOKENS, 'eth', 'eth').contract).toBeNull();
  });

  it('picks the coin by its ticker when 1Click lists two contract-less tokens', () => {
    expect(resolveCrossChainAsset(TOKENS, 'btc', 'native').assetId).toBe(
      'nep141:btc.omft.near',
    );
    expect(resolveCrossChainAsset(TOKENS, 'btc', 'BTC').assetId).toBe(
      'nep141:btc.omft.near',
    );
    // The other one is still reachable by its own symbol.
    expect(resolveCrossChainAsset(TOKENS, 'btc', 'btc(omni)').assetId).toBe(
      '1cs_v1:btc:native:coin',
    );
  });

  it('names the native coin by its ticker or by the symbol 1Click gives it', () => {
    expect(resolveCrossChainAsset(TOKENS, 'ton', 'TON').symbol).toBe('GRAM');
    expect(resolveCrossChainAsset(TOKENS, 'ton', 'gram').symbol).toBe('GRAM');
    expect(resolveCrossChainAsset(TOKENS, 'ton', 'native').symbol).toBe('GRAM');
  });

  it('refuses "native" on a network where 1Click lists no native coin', () => {
    expect(codeOf(() => resolveCrossChainAsset(TOKENS, 'near', 'native'))).toBe(
      ApiErrorCode.AssetUnsupported,
    );
    expect(resolveCrossChainAsset(TOKENS, 'near', 'wNEAR').contract).toBe(
      'wrap.near',
    );
  });

  it('finds a token by a symbol listed once on the chain', () => {
    const usdc = resolveCrossChainAsset(TOKENS, 'solana', 'USDC');
    expect(usdc.contract).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(usdc.decimals).toBe(6);
    expect(resolveCrossChainAsset(TOKENS, 'eth', 'usdc').contract).toBe(
      ETH_USDC,
    );
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

  it('finds an ERC-20 by its address in any case, on every EVM network', () => {
    expect(
      resolveCrossChainAsset(
        TOKENS,
        'monad',
        '0x754704BC059F8C67012FED69BC8A327A5AAFB603',
      ).symbol,
    ).toBe('USDC');
    expect(
      resolveCrossChainAsset(
        TOKENS,
        'eth',
        ETH_USDC.toUpperCase().replace('0X', '0x'),
      ).assetId,
    ).toBe('nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near');
  });

  it('compares a contract exactly where the encoding is case-sensitive', () => {
    expect(
      codeOf(() =>
        resolveCrossChainAsset(
          TOKENS,
          'solana',
          'EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V',
        ),
      ),
    ).toBe(ApiErrorCode.AssetUnsupported);
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
    expect(codeOf(() => resolveCrossChainAsset(TOKENS, 'btc', 'USDC'))).toBe(
      ApiErrorCode.AssetUnsupported,
    );
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
