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

describe('parseEvmTokenFees for Arc', () => {
  it('names the variable it parses in every refusal', () => {
    expect(() => parseEvmTokenFees('[]', 'ARC_DEPOSIT_TOKEN_FEES')).toThrow(
      'ARC_DEPOSIT_TOKEN_FEES must be a JSON object',
    );
    expect(() =>
      parseEvmTokenFees('{"0x12": "1"}', 'ARC_DEPOSIT_TOKEN_FEES'),
    ).toThrow(/^ARC_DEPOSIT_TOKEN_FEES: "0x12"/);
    // Monad's name stays the default.
    expect(() => parseEvmTokenFees('[]')).toThrow(/^MONAD_DEPOSIT_TOKEN_FEES/);
  });
});
