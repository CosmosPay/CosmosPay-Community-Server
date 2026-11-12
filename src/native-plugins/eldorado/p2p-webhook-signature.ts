import {
  createHash,
  createPublicKey,
  createVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { P2P_WEBHOOK_MAX_SIGNATURE_CHARS } from '@/native-plugins/eldorado/eldorado.constants';

/**
 * How the P2P marketplace signs its webhooks (from its documentation's sample,
 * checked 2026-11-12), as pure functions:
 *
 *   1. `x-webhook-hash` is `sha256(rawBody)` as lowercase hex;
 *   2. `x-webhook-signature` is base64 of an RSA-SHA256 (PKCS#1 v1.5) signature
 *      over that hex STRING (not the raw digest), by a key of the marketplace's
 *      JWKS (`/.well-known/jwks.json`, RS256).
 *
 * Both are checked against the exact bytes received: a body parsed and
 * re-serialized is not the body that was signed.
 */

/** `sha256(raw)` as lowercase hex. */
export function webhookBodyHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Whether `presented` is the body's hash, compared in constant time. */
export function webhookHashMatches(
  raw: Buffer,
  presented: string | undefined,
): boolean {
  if (!presented) return false;
  const expected = Buffer.from(webhookBodyHash(raw), 'utf8');
  const given = Buffer.from(presented.trim(), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Whether `signature` (base64) is an RSA-SHA256 signature of `hashHex` by
 * `key`. Anything malformed is a plain false, never a throw.
 */
export function webhookSignatureVerifies(
  hashHex: string,
  signature: string,
  key: KeyObject,
): boolean {
  const text = signature.trim();
  if (
    !text ||
    text.length > P2P_WEBHOOK_MAX_SIGNATURE_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(text)
  ) {
    return false;
  }
  try {
    return createVerify('RSA-SHA256')
      .update(hashHex, 'utf8')
      .verify(key, text, 'base64');
  } catch {
    return false;
  }
}

/** Whether any of `keys` verifies the signature, the set's first key first. */
export function webhookSignedByAny(
  hashHex: string,
  signature: string,
  keys: readonly KeyObject[],
): boolean {
  return keys.some((key) => webhookSignatureVerifies(hashHex, signature, key));
}

/**
 * The RSA public keys of a JWKS (`{ keys: [...] }`), in its order. An entry
 * that is not an RSA signing key (`kty` other than RSA, `use` other than `sig`,
 * no modulus or exponent) or does not import is skipped.
 */
export function readWebhookJwks(raw: unknown): KeyObject[] {
  const list =
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { keys?: unknown }).keys)
      ? (raw as { keys: unknown[] }).keys
      : [];
  const keys: KeyObject[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== 'RSA') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    try {
      keys.push(
        createPublicKey({
          key: { kty: 'RSA', n: jwk.n, e: jwk.e },
          format: 'jwk',
        }),
      );
    } catch {
      // Not a key Node can import: skipped, like any other unusable entry.
    }
  }
  return keys;
}
