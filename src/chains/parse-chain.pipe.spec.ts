import { ParseOptionalChainPipe } from '@/chains/parse-chain.pipe';
import { ApiError } from '@/common/errors/api-error';

describe('ParseOptionalChainPipe', () => {
  const pipe = new ParseOptionalChainPipe();

  it('passes a chain through and leaves an absent one absent', () => {
    expect(pipe.transform('solana')).toBe('solana');
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform('')).toBeUndefined();
  });

  it.each(['bitcoin', 'toString', '__proto__'])('refuses %p', (value) => {
    expect(() => pipe.transform(value)).toThrow(ApiError);
  });
});
