import {
  constants,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';

/**
 * OpenID Connect ID-token verification, with `node:crypto` and nothing else.
 *
 * This is how the service trusts Authentik (or any OIDC provider the operator
 * names) without sharing a secret with it: an ID token is signed with the
 * provider's PRIVATE key and checked here against the public keys it publishes.
 * That asymmetry is the point. The recovery servers used to accept an identity
 * sealed under an HMAC secret that the sign-in server also held — so whoever
 * read that secret off any one of three hosts could mint an identity every
 * recovery server believed. A public key minted nothing.
 *
 * Pure: the key set and the expectations come in as arguments, so the spec
 * reaches every refusal without a network. `oidc.service.ts` does the fetching.
 *
 * ## The order of the checks is the order that matters
 *
 *  1. The header, before any key is chosen: only the asymmetric algorithms this
 *     file knows. `none` and every `HS*` are refused, because an HMAC "verified"
 *     with a public key as its secret is the oldest bug in the format.
 *  2. The key, chosen by `kid` and required to agree with the header's algorithm
 *     — a JWK that says `alg: RS256` is not usable for an `ES256` token even when
 *     the math would happen to run.
 *  3. The signature.
 *  4. Only then the claims: issuer exactly, audience in the allowed set (and the
 *     authorized party when there are several), expiry, not-before, issued-at,
 *     the nonce this service sent, the age of the login, and an email the
 *     provider says it VERIFIED.
 */

export type IdTokenFailure =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'too_old'
  | 'wrong_nonce'
  | 'email_missing'
  | 'email_unverified';

export type IdTokenResult =
  { ok: true; claims: IdTokenClaims } | { ok: false; error: IdTokenFailure };

/** The claims a caller may act on, reduced from what the provider sent. */
export interface IdTokenClaims {
  iss: string;
  sub: string;
  /** Lowercased and trimmed: accounts are looked up by it. */
  email: string;
  name: string | null;
  picture: string | null;
  iat: number;
  exp: number;
  /** When the person actually authenticated; `iat` when the provider omits it. */
  authTime: number;
}

export interface IdTokenExpectations {
  /** The issuer EXACTLY as the provider's discovery document states it. */
  issuer: string;
  /** Client ids this token may have been minted for. At least one. */
  audiences: readonly string[];
  /** The nonce sent in the authorization request, when this service sent one. */
  nonce?: string;
  /**
   * The oldest login accepted, in seconds. A token is a bearer credential, so
   * one that is still inside its `exp` but was issued for a login an hour ago is
   * a login nobody is sitting in front of any more.
   */
  maxAgeSeconds?: number;
  /** Tolerated clock difference, both ways. */
  skewSeconds?: number;
}

/** A public JWK (RFC 7517). Only the members this file reads are named. */
export interface Jwk {
  kty: string;
  crv?: string;
  kid?: string;
  alg?: string;
  use?: string;
  [member: string]: unknown;
}

const DEFAULT_SKEW_S = 60;

/**
 * The algorithms accepted, and the key type each one needs. A Map for the same
 * reason `providerFromWire` uses one: the value comes off the wire, and an object
 * literal answers `__proto__` and `constructor` from its prototype.
 */
const ALGORITHMS = new Map<string, { kty: string; crv?: string }>([
  ['RS256', { kty: 'RSA' }],
  ['PS256', { kty: 'RSA' }],
  ['ES256', { kty: 'EC', crv: 'P-256' }],
  ['EdDSA', { kty: 'OKP', crv: 'Ed25519' }],
]);

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    );
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The header's algorithm and key id, before anything is verified. */
export function peekHeader(
  token: string,
): { alg: string; kid: string | null } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = decodeSegment(parts[0]);
  if (!header || typeof header.alg !== 'string') return null;
  return {
    alg: header.alg,
    kid: typeof header.kid === 'string' ? header.kid : null,
  };
}

/**
 * The key a token names, or null.
 *
 * With a `kid`, only that key. Without one, only when the set holds exactly ONE
 * signing key the algorithm can use — guessing among several would be letting
 * the token pick whichever key its signature happens to verify under.
 */
export function selectKey(
  keys: readonly Jwk[],
  alg: string,
  kid: string | null,
): Jwk | null {
  const want = ALGORITHMS.get(alg);
  if (!want) return null;
  const usable = keys.filter(
    (k) =>
      k.kty === want.kty &&
      (!want.crv || k.crv === want.crv) &&
      (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === alg),
  );
  if (kid !== null) return usable.find((k) => k.kid === kid) ?? null;
  return usable.length === 1 ? usable[0] : null;
}

function verifySignature(
  alg: string,
  key: KeyObject,
  data: Buffer,
  signature: Buffer,
): boolean {
  switch (alg) {
    case 'RS256':
      return verify('sha256', data, key, signature);
    case 'PS256':
      return verify(
        'sha256',
        data,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signature,
      );
    case 'ES256':
      // JWS carries ECDSA as r||s, not DER.
      return verify(
        'sha256',
        data,
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    case 'EdDSA':
      return verify(null, data, key, signature);
    default:
      return false;
  }
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Verify an ID token against a key set and the expectations of the caller.
 *
 * Never throws: every input arrives from the wire, and a verifier that crashes
 * on junk is a denial of service on whatever route calls it.
 */
export function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  expect: IdTokenExpectations,
  nowSeconds = Math.floor(Date.now() / 1000),
): IdTokenResult {
  const header = peekHeader(token);
  if (!header) return { ok: false, error: 'malformed' };
  if (!ALGORITHMS.has(header.alg))
    return { ok: false, error: 'unsupported_alg' };

  const jwk = selectKey(keys, header.alg, header.kid);
  if (!jwk) return { ok: false, error: 'unknown_key' };

  const [h, p, s] = token.split('.');
  let valid: boolean;
  try {
    // The JWK is data from the provider, typed loosely on purpose; node's own
    // parser is what validates it, and a malformed one throws into the catch.
    const key = createPublicKey({
      key: jwk,
      format: 'jwk',
    } as unknown as Parameters<typeof createPublicKey>[0]);
    valid = verifySignature(
      header.alg,
      key,
      Buffer.from(`${h}.${p}`),
      Buffer.from(s, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'bad_signature' };

  const c = decodeSegment(p);
  if (!c) return { ok: false, error: 'malformed' };
  const skew = expect.skewSeconds ?? DEFAULT_SKEW_S;

  if (c.iss !== expect.issuer) return { ok: false, error: 'wrong_issuer' };

  const aud =
    typeof c.aud === 'string'
      ? [c.aud]
      : Array.isArray(c.aud)
        ? c.aud.filter((a) => typeof a === 'string')
        : [];
  if (!aud.length || !aud.some((a) => expect.audiences.includes(a))) {
    return { ok: false, error: 'wrong_audience' };
  }
  // OIDC Core 3.1.3.7: with several audiences, the party the token was issued TO
  // must be one of ours — otherwise a token minted for some other client that
  // merely lists us too would pass.
  if (
    aud.length > 1 &&
    !(typeof c.azp === 'string' && expect.audiences.includes(c.azp))
  ) {
    return { ok: false, error: 'wrong_audience' };
  }

  if (typeof c.exp !== 'number' || c.exp <= nowSeconds - skew)
    return { ok: false, error: 'expired' };
  if (typeof c.iat !== 'number' || c.iat > nowSeconds + skew)
    return { ok: false, error: 'not_yet_valid' };
  if (
    c.nbf !== undefined &&
    (typeof c.nbf !== 'number' || c.nbf > nowSeconds + skew)
  ) {
    return { ok: false, error: 'not_yet_valid' };
  }

  const authTime = typeof c.auth_time === 'number' ? c.auth_time : c.iat;
  if (
    expect.maxAgeSeconds !== undefined &&
    nowSeconds - authTime > expect.maxAgeSeconds + skew
  ) {
    return { ok: false, error: 'too_old' };
  }

  if (expect.nonce !== undefined && c.nonce !== expect.nonce)
    return { ok: false, error: 'wrong_nonce' };

  const sub = str(c.sub);
  const email = str(c.email)?.toLowerCase() ?? null;
  if (!sub || !email) return { ok: false, error: 'email_missing' };
  // Literally `true`. Accounts are looked up by email, so an address the provider
  // never confirmed is a way to sign in as somebody else's existing account.
  if (c.email_verified !== true)
    return { ok: false, error: 'email_unverified' };

  return {
    ok: true,
    claims: {
      iss: c.iss,
      sub,
      email,
      name: str(c.name) ?? str(c.preferred_username),
      picture: httpsUrl(c.picture),
      iat: c.iat,
      exp: c.exp,
      authTime,
    },
  };
}

/** What this service reads from a discovery document. */
export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/**
 * Is this a URL a provider may point us at? https only — loopback excepted, so a
 * provider running on the developer's own machine is usable in development.
 */
export function isProviderUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Where the discovery document for `issuer` lives (OIDC Discovery §4). */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/**
 * Read a discovery document, or null when it is unusable.
 *
 * The `issuer` inside it must equal the configured one EXACTLY (OIDC Discovery
 * §4.3). That is the mix-up defence: a document served from one place that
 * claims to describe another issuer is either misconfigured or an attempt to
 * have this service trust keys it was never told to.
 */
export function parseDiscovery(
  doc: unknown,
  expectedIssuer: string,
): OidcDiscovery | null {
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d.issuer !== expectedIssuer) return null;
  const {
    authorization_endpoint: authz,
    token_endpoint: token,
    jwks_uri: jwks,
  } = d;
  if (!isProviderUrl(authz) || !isProviderUrl(token) || !isProviderUrl(jwks))
    return null;
  return {
    issuer: expectedIssuer,
    authorizationEndpoint: authz,
    tokenEndpoint: token,
    jwksUri: jwks,
  };
}

/** The signing keys of a JWK set, dropping anything that is not one. */
export function parseJwks(doc: unknown): Jwk[] {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (k): k is Jwk =>
      !!k &&
      typeof k === 'object' &&
      typeof (k as Jwk).kty === 'string' &&
      !('d' in (k as object)),
  );
}
