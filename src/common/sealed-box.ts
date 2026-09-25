import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * Seal a JSON value so a caller can hold it and this service can still trust it.
 *
 * AES-256-GCM under a key derived with HKDF from a server secret and a PURPOSE
 * string. Two properties follow, and both are the reason this exists:
 *
 *  * The purpose is part of the derivation, so a box sealed for one use does not
 *    open as another. A token issued to finish a sign-in cannot be presented
 *    where a different flow expects its own sealed state.
 *  * The GCM tag means a modified box fails to open rather than decrypting to
 *    something else. A caller can hold the box; it cannot edit the claims inside
 *    it.
 *
 * `openJson` returns null on every failure — wrong key, wrong purpose, tampered,
 * truncated, or a string that was never a box — because the caller's answer to
 * all of them is identical: the state this box stood for is gone. Branching on
 * *why* would leak which of those it was.
 *
 * Ported from the developer platform's `src/lib/sealed-box.ts`, which is where
 * the wallet sign-in this service now serves was first written. The format is
 * deliberately byte-compatible with it: during the migration both sides issue
 * and read the same tokens.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** HKDF's `info` for every box. The per-use separation is `purpose`, not this. */
const HKDF_SALT = 'cosmos-sealed-box';

function keyFor(secret: string, purpose: string): Buffer {
  if (!secret) throw new Error('sealed-box: a non-empty secret is required');
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, purpose, 32));
}

/** Seal `value` under `secret` for `purpose`. The result is URL-safe. */
export function sealJson(
  value: unknown,
  secret: string,
  purpose: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv, {
    authTagLength: TAG_BYTES,
  });
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/** What `sealed` carries, or null when it is forged, edited, stale or junk. */
export function openJson<T>(
  sealed: string,
  secret: string,
  purpose: string,
): T | null {
  try {
    const [version, iv, tag, body, extra] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || !body || extra !== undefined)
      return null;
    const tagBytes = Buffer.from(tag, 'base64url');
    // A short tag is a weaker check, not a different encoding: refuse it outright.
    if (tagBytes.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(secret, purpose),
      Buffer.from(iv, 'base64url'),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAuthTag(tagBytes);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    return null;
  }
}
