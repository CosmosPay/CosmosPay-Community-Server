import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';
import type { Chain } from '@/chains/chains.constants';
import { IsSwapAsset } from '@/common/validators/is-swap-asset.validator';

class Body {
  @IsOptional()
  chain?: Chain;

  @IsSwapAsset('chain')
  asset!: string;
}

function errors(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(Body, body)).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );
}

describe('IsSwapAsset', () => {
  it('is the Stellar asset-code rule, message and all, when no chain is named', () => {
    expect(errors({ asset: 'USDC' })).toEqual([]);
    expect(errors({ asset: 'US-DC' })).toEqual([
      'asset must be 1-12 alphanumeric characters',
    ]);
  });

  it('takes SOL, native or a mint on Solana', () => {
    for (const asset of [
      'SOL',
      'native',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ]) {
      expect(errors({ chain: 'solana', asset })).toEqual([]);
    }
    expect(errors({ chain: 'solana', asset: 'USDC' })).toEqual([
      'asset must be SOL, "native" or an SPL mint address for chain solana',
    ]);
  });

  it('takes MON, native or an ERC-20 address on Monad', () => {
    expect(
      errors({
        chain: 'monad',
        asset: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
      }),
    ).toEqual([]);
    expect(errors({ chain: 'monad', asset: 'mon' })).toEqual([]);
    expect(
      errors({
        chain: 'monad',
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      }),
    ).toHaveLength(1);
  });
});
