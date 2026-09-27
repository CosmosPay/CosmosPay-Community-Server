import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * HS256 JSON Web Tokens this service mints for itself, with `node:crypto` only.
 *
 * Used where a STANDARD says the credential is a JWT — SEP-10's token is one,
 * and a third-party SEP-30 client may decode it to read `sub` and `exp` — so a
 * sealed box (`@/common/sealed-box`) would be the wrong shape even though it is
 * the better primitive for our own state.
 *
 * ## The key is derived per PURPOSE
 *
 * The HMAC key is `HKDF(secret, purpose)`, never the secret itself. Two tokens
 * minted from one secret for different purposes — a SEP-10 token that says "holds
 * this account's key" and an identity token that says "proved this inbox" — then
 * cannot be presented for each other: the signature simply does not verify. That
 * separation is the whole defence against a confused deputy between the two, so
 * `readJwt` never falls back to trying another purpose.
 *
 * ## What is refused
 *
 * Anything that is not exactly `{"alg":"HS256","typ":"JWT"}` in the header. `none`,
 * an RS/ES algorithm, or a missing `typ` never reach the HMAC comparison: the
 * classic JWT confusion bugs are a verifier that believed the header about how to
 * verify, and this one does not read it for anything but refusal.
 */

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const HEADER_B64 = b64url(JSON.stringify(HEADER));

/** HKDF's salt for every token key. The per-use separation is `purpose`. */
const HKDF_SALT = 'cosmos-jwt';

/** The claims every token carries. Extra claims ride along untouched. */
export interface JwtClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  [claim: string]: unknown;
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function keyFor(secret: string, purpose: string): Buffer {
  if (!secret) throw new Error('jwt: a non-empty secret is required');
  if (!purpose) throw new Error('jwt: a purpose is required');
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, purpose, 32));
}

function mac(signingInput: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(signingInput).digest();
}

/**
 * Mint a token. `jti` is filled in when the caller leaves it out, so every token
 * is distinct even when two are minted for the same subject in the same second —
 * which is what lets a server record one as spent without spending its twin.
 */
export function issueJwt(
  claims: Omit<JwtClaims, 'jti'> & { jti?: string },
  secret: string,
  purpose: string,
): string {
  const body = {
    ...claims,
    jti: claims.jti ?? randomBytes(16).toString('hex'),
  };
  const signingInput = `${HEADER_B64}.${b64url(JSON.stringify(body))}`;
  return `${signingInput}.${mac(signingInput, keyFor(secret, purpose)).toString('base64url')}`;
}

/**
 * The claims of a token minted here for `purpose`, or null.
 *
 * Null for every failure — wrong purpose, wrong secret, tampered, expired, not
 * yet valid, malformed — because a caller's answer to all of them is the same
 * 401, and branching on why would tell a caller which part it got right.
 * `audience` is checked here rather than left to the caller: a token minted by
 * the sibling recovery server shares nothing with this one but the format, and a
 * check that lived at each call site is one a new route forgets.
 */
export function readJwt(
  token: string,
  secret: string,
  purpose: string,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): JwtClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  // Byte-for-byte the header this module writes. Nothing a caller put there is
  // read, so there is nothing a caller can put there to change how it verifies.
  if (header !== HEADER_B64) return null;

  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  const want = mac(`${header}.${payload}`, keyFor(secret, purpose));
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return null;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims))
    return null;
  const { sub, iss, aud, iat, exp, jti } = claims;
  if (typeof sub !== 'string' || !sub) return null;
  if (typeof iss !== 'string' || typeof jti !== 'string') return null;
  if (aud !== audience) return null;
  if (typeof iat !== 'number' || typeof exp !== 'number') return null;
  if (exp <= nowSeconds || iat > nowSeconds + 60) return null;
  return claims as JwtClaims;
}
