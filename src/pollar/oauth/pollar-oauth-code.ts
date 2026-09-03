import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  POLLAR_CODE_BYTES,
  POLLAR_STATE_BYTES,
} from '@/pollar/pollar.constants';

/** base64url of `bytes` random bytes — URL-safe, so it survives a redirect. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** A fresh handshake handle. Public: it travels in the callback URL. */
export function mintState(): string {
  return randomToken(POLLAR_STATE_BYTES);
}

/** A fresh single-use bridge code. Secret: it redeems a Pollar session. */
export function mintCode(): string {
  return randomToken(POLLAR_CODE_BYTES);
}

/**
 * What we persist in place of a code. Storing the code itself would make a read
 * of the table enough to redeem a handshake; the hash is enough to look one up.
 * Plain SHA-256 rather than a password hash on purpose — the input is 32 bytes
 * of entropy, so there is nothing to brute-force, and the lookup has to be a
 * single indexed equality.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('base64url');
}

/**
 * PKCE (RFC 7636) S256 verification: `BASE64URL(SHA256(verifier)) == challenge`.
 *
 * Compared in constant time. The challenge is not a secret, but the comparison
 * sits on the redemption path next to the code check, and a byte-by-byte
 * early-exit there is the kind of thing that only ever gets noticed after it
 * matters.
 */
export function verifyPkce(challenge: string, verifier: string): boolean {
  const expected = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
