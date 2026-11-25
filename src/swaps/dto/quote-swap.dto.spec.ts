import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QuerySwapsDto } from '@/swaps/dto/query-swaps.dto';
import { QuoteSwapDto } from '@/swaps/dto/quote-swap.dto';

function errorsOf(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(QuoteSwapDto, body)).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );
}

describe('QuoteSwapDto on Arc', () => {
  it('refuses Arc in validation: it has no swap route', () => {
    expect(
      errorsOf({
        chain: 'arc',
        amount: '1',
        sourceAssetCode: 'native',
        destAssetCode: '0x3600000000000000000000000000000000000000',
      }),
    ).toContain(
      'chain must be one of the following values: stellar, solana, monad',
    );
  });

  it('still takes the chains with a route', () => {
    expect(
      errorsOf({
        chain: 'monad',
        amount: '1',
        sourceAssetCode: 'native',
        destAssetCode: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      }),
    ).toEqual([]);
  });

  it('refuses Arc as a swap list filter too', () => {
    const errors = validateSync(
      plainToInstance(QuerySwapsDto, { chain: 'arc' }),
    ).flatMap((e) => Object.values(e.constraints ?? {}));
    expect(errors).toContain(
      'chain must be one of the following values: stellar, solana, monad',
    );
  });
});
