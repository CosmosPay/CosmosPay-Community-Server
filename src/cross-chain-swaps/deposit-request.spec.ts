import { depositLink } from '@/cross-chain-swaps/deposit-request';

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
});
