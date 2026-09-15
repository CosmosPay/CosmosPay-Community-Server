import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  resolveIdempotencyKey,
  resolveSlippage,
} from '@/stellar/stellar-operation-policy';

/**
 * Swaps and liquidity pools each had a private copy of these. They are pinned
 * here once, so a change to either rule is a change to both flows on purpose.
 */
describe('resolveSlippage', () => {
  const policy = { slippageBps: 50, maxSlippageBps: 500 };

  it('applies the configured default when the caller names no tolerance', () => {
    expect(resolveSlippage(undefined, policy)).toBe(50);
  });

  it("keeps the caller's tolerance, including zero, up to the cap", () => {
    expect(resolveSlippage(0, policy)).toBe(0);
    expect(resolveSlippage(120, policy)).toBe(120);
    expect(resolveSlippage(500, policy)).toBe(500);
  });

  it('refuses a tolerance over the cap instead of clamping it', () => {
    let thrown: unknown;
    try {
      resolveSlippage(501, policy);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((thrown as ApiError).code).toBe(ApiErrorCode.SlippageExceeded);
    expect((thrown as ApiError).message).toBe(
      'slippageBps 501 exceeds the maximum allowed (500)',
    );
  });

  it('checks a default that is itself over the cap', () => {
    // A misconfigured default must fail loudly, not price every envelope at it.
    expect(() =>
      resolveSlippage(undefined, { slippageBps: 900, maxSlippageBps: 500 }),
    ).toThrow(ApiError);
  });
});

describe('resolveIdempotencyKey', () => {
  it('lets the header win over the body field', () => {
    expect(resolveIdempotencyKey('header-key', 'body-key')).toBe('header-key');
  });

  it('falls back to the body when no header was sent', () => {
    expect(resolveIdempotencyKey(undefined, 'body-key')).toBe('body-key');
  });

  it('trims the key', () => {
    expect(resolveIdempotencyKey('  spaced  ')).toBe('spaced');
  });

  it('treats absent and blank keys as no key', () => {
    expect(resolveIdempotencyKey()).toBeNull();
    expect(resolveIdempotencyKey('')).toBeNull();
    expect(resolveIdempotencyKey('   ')).toBeNull();
    expect(resolveIdempotencyKey(undefined, '  ')).toBeNull();
  });

  it('does not fall back to the body when the header is blank', () => {
    // `??` only skips an absent header; a blank one is still what was sent.
    expect(resolveIdempotencyKey('  ', 'body-key')).toBeNull();
  });
});
