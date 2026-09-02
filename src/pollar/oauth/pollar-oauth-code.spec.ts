import { createHash } from 'node:crypto';
import {
  hashCode,
  mintCode,
  mintState,
  verifyPkce,
} from '@/pollar/oauth/pollar-oauth-code';

describe('mintState / mintCode', () => {
  it('produces URL-safe 32-byte values', () => {
    for (const value of [mintState(), mintCode()]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(value, 'base64url')).toHaveLength(32);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintCode()));
    expect(seen.size).toBe(200);
  });
});

describe('hashCode', () => {
  it('is the base64url SHA-256 of the code', () => {
    expect(hashCode('abc')).toBe(
      createHash('sha256').update('abc').digest('base64url'),
    );
  });

  it('never returns the code it was given', () => {
    const code = mintCode();
    expect(hashCode(code)).not.toBe(code);
  });
});

describe('verifyPkce', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('accepts the verifier its challenge was derived from', () => {
    expect(verifyPkce(challenge, verifier)).toBe(true);
  });

  it('rejects any other verifier', () => {
    expect(verifyPkce(challenge, `${verifier}x`)).toBe(false);
    expect(verifyPkce(challenge, '')).toBe(false);
  });

  it('rejects a challenge of the wrong length instead of throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which on the redemption
    // path would surface as a 500 for what is plainly a bad request.
    expect(verifyPkce('short', verifier)).toBe(false);
  });
});
