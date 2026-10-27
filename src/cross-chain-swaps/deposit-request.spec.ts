import type { CrossChainAsset } from '@/cross-chain-swaps/cross-chain-assets';
import { depositLink } from '@/cross-chain-swaps/cross-chain-networks';
import type { CrossChainNetworkId } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import {
  bip21DepositLink,
  cardanoDepositLink,
  eip681DepositLink,
  memoless,
  tonDepositLink,
} from '@/cross-chain-swaps/deposit-request';

const STELLAR_DEPOSIT =
  'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function asset(
  chain: CrossChainNetworkId,
  symbol: string,
  decimals: number,
  contract: string | null = null,
): CrossChainAsset {
  return {
    chain,
    chainName: chain,
    symbol,
    assetId: 'x',
    decimals,
    contract,
    priceUsd: null,
  };
}

describe('depositLink', () => {
  it('Stellar: a SEP-7 pay link carrying the memo as MEMO_TEXT', () => {
    const uri = depositLink({
      address: STELLAR_DEPOSIT,
      memo: '188866795',
      amount: '100',
      asset: asset('stellar', 'USDC', 7, USDC_ISSUER),
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
        asset: asset('stellar', 'XLM', 7),
      }),
    ).toThrow('memo');
  });

  it('Solana: a Solana Pay transfer, spl-token for a token', () => {
    expect(
      depositLink({
        address: 'Dep1111111111111111111111111111111111111111',
        memo: null,
        amount: '2.5',
        asset: asset(
          'solana',
          'USDC',
          6,
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        ),
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
        asset: asset('monad', 'MON', 18),
      }),
    ).toBe(`ethereum:${deposit}@143?value=1500000000000000000`);

    const usdc = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
    expect(
      depositLink({
        address: deposit,
        memo: null,
        amount: '10',
        asset: asset('monad', 'USDC', 6, usdc),
      }),
    ).toBe(`ethereum:${usdc}@143/transfer?address=${deposit}&uint256=10000000`);
  });

  it('is null on a network with no wallet-link standard', () => {
    expect(
      depositLink({
        address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        memo: null,
        amount: '5',
        asset: asset('xrp', 'XRP', 6),
      }),
    ).toBeNull();
  });
});

describe('deposit link builders', () => {
  const deposit = '0x76b4c56085ED136a8744D52bE956396624a730E8';

  it('EIP-681 names the chain id it was built with', () => {
    expect(
      eip681DepositLink(8453)({
        address: deposit,
        memo: null,
        amount: '0.01',
        asset: asset('base', 'ETH', 18),
      }),
    ).toBe(`ethereum:${deposit}@8453?value=10000000000000000`);
  });

  it('BIP-21 style: the coin in decimal, and no link for a token', () => {
    const build = bip21DepositLink('bitcoin');
    expect(
      build({
        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        memo: null,
        amount: '0.0015',
        asset: asset('btc', 'BTC', 8),
      }),
    ).toBe('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.0015');
    expect(
      build({
        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        memo: null,
        amount: '1',
        asset: asset('btc', 'TOKEN', 8, 'some-contract'),
      }),
    ).toBeNull();
  });

  it('BIP-21 style: does not prefix a cashaddr that already carries the scheme', () => {
    const build = bip21DepositLink('bitcoincash');
    const cashaddr = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
    for (const address of [cashaddr, `bitcoincash:${cashaddr}`]) {
      expect(
        build({
          address,
          memo: null,
          amount: '2',
          asset: asset('bch', 'BCH', 8),
        }),
      ).toBe(`bitcoincash:${cashaddr}?amount=2`);
    }
  });

  it('TON: nanotons for the coin, no link for a jetton', () => {
    const address = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
    expect(
      tonDepositLink({
        address,
        memo: null,
        amount: '1.25',
        asset: asset('ton', 'TON', 9),
      }),
    ).toBe(`ton://transfer/${address}?amount=1250000000`);
    expect(
      tonDepositLink({
        address,
        memo: null,
        amount: '1',
        asset: asset('ton', 'USDT', 6, address),
      }),
    ).toBeNull();
  });

  it('Cardano: CIP-13 in decimal ADA, ADA only', () => {
    const address =
      'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
    expect(
      cardanoDepositLink({
        address,
        memo: null,
        amount: '12.5',
        asset: asset('cardano', 'ADA', 6),
      }),
    ).toBe(`web+cardano:${address}?amount=12.5`);
    expect(
      cardanoDepositLink({
        address,
        memo: null,
        amount: '1',
        asset: asset('cardano', 'HOSKY', 0, 'policy.asset'),
      }),
    ).toBeNull();
  });

  it('memoless: no link when 1Click issued a memo the link cannot carry', () => {
    const build = memoless(eip681DepositLink(1));
    const terms = {
      address: deposit,
      amount: '1',
      asset: asset('eth', 'ETH', 18),
    };
    expect(build({ ...terms, memo: null })).toBe(
      `ethereum:${deposit}@1?value=1000000000000000000`,
    );
    expect(build({ ...terms, memo: '42' })).toBeNull();
  });
});
