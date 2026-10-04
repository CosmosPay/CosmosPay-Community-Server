import { parseEvmTokenFees } from '@/config/evm-token-fees';

const TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

describe('parseEvmTokenFees', () => {
  it('is empty when unset', () => {
    expect(parseEvmTokenFees(undefined)).toEqual({});
    expect(parseEvmTokenFees('  ')).toEqual({});
  });

  it('keys fees by the lowercase token address', () => {
    expect(parseEvmTokenFees(JSON.stringify({ [TOKEN]: '0.05' }))).toEqual({
      [TOKEN.toLowerCase()]: '0.05',
    });
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a key that is not an address', JSON.stringify({ USDC: '0.05' })],
    ['a numeric fee', JSON.stringify({ [TOKEN]: 0.05 })],
    ['a negative fee', JSON.stringify({ [TOKEN]: '-1' })],
  ])('refuses %s, naming the variable', (_label, raw) => {
    expect(() => parseEvmTokenFees(raw)).toThrow(/MONAD_DEPOSIT_TOKEN_FEES/);
  });
});
