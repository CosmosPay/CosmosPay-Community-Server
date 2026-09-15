import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { resolveMemoId, resolveOrMintMemoId } from '@/stellar/memo';
import { MAX_UINT64 } from '@/stellar/stellar.constants';

/**
 * Payment intents need a memo on every intent, so they take the caller's when it
 * is valid and mint one otherwise. `resolveMemoId` itself is covered in
 * `stellar-helpers.spec.ts`; these pin what the minting branch adds to it.
 */
describe('resolveOrMintMemoId', () => {
  it("returns the caller's MEMO_ID unchanged, up to the uint64 boundary", () => {
    expect(resolveOrMintMemoId('0')).toBe('0');
    expect(resolveOrMintMemoId('123456789')).toBe('123456789');
    expect(resolveOrMintMemoId(MAX_UINT64.toString())).toBe(
      MAX_UINT64.toString(),
    );
  });

  it('refuses a malformed memo instead of minting a different one over it', () => {
    // The empty string matters most: treating it as "no memo" would hand the
    // caller an intent under a memo they never asked for.
    for (const bad of [
      '',
      '-1',
      '1.5',
      '0x10',
      'abc',
      ' 12',
      (MAX_UINT64 + 1n).toString(),
    ]) {
      let thrown: unknown;
      try {
        resolveOrMintMemoId(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect((thrown as ApiError).code).toBe(ApiErrorCode.InvalidMemo);
    }
  });

  it('mints a MEMO_ID spelled the way Horizon reports one', () => {
    const minted = resolveOrMintMemoId();

    // Valid by the same rule a caller's memo is held to...
    expect(resolveMemoId(minted)).toBe(minted);
    // ...and canonical decimal. The verifier compares the stored memo to
    // Horizon's as strings, so a zero-padded or hex spelling of the same number
    // would never match the intent's own payment.
    expect(BigInt(minted).toString()).toBe(minted);
  });

  it('draws from the whole uint64 range, not a float-safe subset', () => {
    // A generator routed through `Number` tops out at 2^53 and silently gives
    // up 11 of the 64 bits the memo space has. A fair draw lands at or below
    // that with probability 2^-11, so twenty-four of them never all do.
    const draws = Array.from({ length: 24 }, () =>
      BigInt(resolveOrMintMemoId()),
    );

    expect(draws.some((d) => d > BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(new Set(draws).size).toBe(draws.length);
  });
});
