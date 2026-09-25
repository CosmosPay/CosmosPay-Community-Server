import {
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  discoveryUrl,
  parseDiscovery,
  parseJwks,
  selectKey,
  verifyIdToken,
  type Jwk,
} from '@/common/oidc/oidc-core';

/*
 * Every refusal here is a way an ID token has been accepted when it should not
 * have been, somewhere. Real keys, real signatures: a verifier tested against
 * stubs proves only that it calls the stub.
 */

const ISSUER = 'https://auth.example.com/application/o/wallet/';
const AUD = 'wallet-client';
const NOW = 1_800_000_000;

const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString('base64url');

function keyPair(kind: 'rsa' | 'ec' | 'ed25519', kid: string) {
  const pair =
    kind === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : kind === 'ec'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('ed25519');
  const jwk = {
    ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid,
    use: 'sig',
  } as Jwk;
  return { privateKey: pair.privateKey, jwk };
}

function jwt(
  alg: string,
  kid: string | null,
  claims: Record<string, unknown>,
  key: KeyObject,
): string {
  const header = b64({ alg, typ: 'JWT', ...(kid ? { kid } : {}) });
  const input = Buffer.from(`${header}.${b64(claims)}`);
  const sig =
    alg === 'RS256'
      ? sign('sha256', input, key)
      : alg === 'ES256'
        ? sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' })
        : sign(null, input, key);
  return `${input.toString()}.${sig.toString('base64url')}`;
}

const good = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUD,
  sub: 'user-1',
  email: 'Ada@Example.com',
  email_verified: true,
  name: 'Ada',
  iat: NOW - 10,
  exp: NOW + 300,
  nonce: 'n-1',
  ...over,
});

const expect_ = { issuer: ISSUER, audiences: [AUD], nonce: 'n-1' };

describe('verifyIdToken', () => {
  const rsa = keyPair('rsa', 'k-rsa');
  const ec = keyPair('ec', 'k-ec');
  const ed = keyPair('ed25519', 'k-ed');
  const keys = [rsa.jwk, ec.jwk, ed.jwk];

  it.each([
    ['RS256', rsa],
    ['ES256', ec],
    ['EdDSA', ed],
  ])('accepts a valid %s token and lowercases the email', (alg, k) => {
    const result = verifyIdToken(
      jwt(alg, k.jwk.kid as string, good(), k.privateKey),
      keys,
      expect_,
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      claims: { email: 'ada@example.com', sub: 'user-1' },
    });
  });

  it('refuses alg none', () => {
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(good())}.`;
    expect(verifyIdToken(token, keys, expect_, NOW)).toEqual({
      ok: false,
      error: 'unsupported_alg',
    });
  });

  /* The classic: an HMAC "verified" with the public key as its secret. */
  it('refuses HS256 even when keyed with the public JWK', () => {
    const header = b64({ alg: 'HS256', typ: 'JWT', kid: 'k-rsa' });
    const input = `${header}.${b64(good())}`;
    const mac = createHmac('sha256', JSON.stringify(rsa.jwk))
      .update(input)
      .digest('base64url');
    expect(verifyIdToken(`${input}.${mac}`, keys, expect_, NOW)).toEqual({
      ok: false,
      error: 'unsupported_alg',
    });
  });

  it('refuses a key whose declared algorithm differs from the header', () => {
    const pinned = { ...rsa.jwk, alg: 'PS256' };
    const token = jwt('RS256', 'k-rsa', good(), rsa.privateKey);
    expect(verifyIdToken(token, [pinned], expect_, NOW)).toEqual({
      ok: false,
      error: 'unknown_key',
    });
  });

  it('refuses an unknown kid rather than trying every key', () => {
    const token = jwt('RS256', 'someone-else', good(), rsa.privateKey);
    expect(verifyIdToken(token, keys, expect_, NOW)).toEqual({
      ok: false,
      error: 'unknown_key',
    });
  });

  it('refuses a token signed by a key that is not in the set', () => {
    const stranger = keyPair('rsa', 'k-rsa');
    const token = jwt('RS256', 'k-rsa', good(), stranger.privateKey);
    expect(verifyIdToken(token, keys, expect_, NOW)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('refuses an edited payload', () => {
    const token = jwt('RS256', 'k-rsa', good(), rsa.privateKey);
    const [h, , s] = token.split('.');
    const edited = `${h}.${b64(good({ email: 'mallory@example.com' }))}.${s}`;
    expect(verifyIdToken(edited, keys, expect_, NOW)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example.com/' }, 'wrong_issuer'],
    [
      'the issuer with its slash dropped',
      { iss: ISSUER.slice(0, -1) },
      'wrong_issuer',
    ],
    ['another audience', { aud: 'someone-else' }, 'wrong_audience'],
    [
      'several audiences with a foreign azp',
      { aud: [AUD, 'other'], azp: 'other' },
      'wrong_audience',
    ],
    ['an expired token', { exp: NOW - 120 }, 'expired'],
    ['a token issued in the future', { iat: NOW + 600 }, 'not_yet_valid'],
    ['a not-before in the future', { nbf: NOW + 600 }, 'not_yet_valid'],
    ['another nonce', { nonce: 'n-2' }, 'wrong_nonce'],
    ['no nonce', { nonce: undefined }, 'wrong_nonce'],
    ['no email', { email: undefined }, 'email_missing'],
    ['an unverified email', { email_verified: false }, 'email_unverified'],
    [
      'email_verified as a string',
      { email_verified: 'true' },
      'email_unverified',
    ],
  ])('refuses %s', (_, over, error) => {
    const token = jwt('RS256', 'k-rsa', good(over), rsa.privateKey);
    expect(verifyIdToken(token, keys, expect_, NOW)).toEqual({
      ok: false,
      error,
    });
  });

  it('accepts several audiences when the authorized party is ours', () => {
    const token = jwt(
      'RS256',
      'k-rsa',
      good({ aud: [AUD, 'other'], azp: AUD }),
      rsa.privateKey,
    );
    expect(verifyIdToken(token, keys, expect_, NOW).ok).toBe(true);
  });

  it('refuses a login older than the maximum age', () => {
    const token = jwt(
      'RS256',
      'k-rsa',
      good({ auth_time: NOW - 3600 }),
      rsa.privateKey,
    );
    expect(
      verifyIdToken(token, keys, { ...expect_, maxAgeSeconds: 900 }, NOW),
    ).toEqual({ ok: false, error: 'too_old' });
  });

  it('never throws on junk', () => {
    for (const junk of [
      '',
      'a.b',
      'a.b.c',
      '...',
      `${b64({ alg: 'RS256' })}.%%%.***`,
    ]) {
      expect(verifyIdToken(junk, keys, expect_, NOW).ok).toBe(false);
    }
  });
});

describe('selectKey', () => {
  const a = keyPair('rsa', 'a').jwk;
  const b = keyPair('rsa', 'b').jwk;

  it('without a kid, picks only when exactly one key could be meant', () => {
    expect(selectKey([a], 'RS256', null)).toBe(a);
    expect(selectKey([a, b], 'RS256', null)).toBeNull();
  });

  it('ignores encryption keys', () => {
    expect(selectKey([{ ...a, use: 'enc' }], 'RS256', 'a')).toBeNull();
  });
});

describe('discovery', () => {
  it('builds the well-known URL from an issuer with or without a trailing slash', () => {
    expect(discoveryUrl(ISSUER)).toBe(
      `${ISSUER}.well-known/openid-configuration`,
    );
    expect(discoveryUrl(ISSUER.slice(0, -1))).toBe(
      `${ISSUER}.well-known/openid-configuration`,
    );
  });

  const doc = {
    issuer: ISSUER,
    authorization_endpoint: 'https://auth.example.com/authorize/',
    token_endpoint: 'https://auth.example.com/token/',
    jwks_uri: 'https://auth.example.com/jwks/',
  };

  it('reads a well-formed document', () => {
    expect(parseDiscovery(doc, ISSUER)).toMatchObject({
      jwksUri: doc.jwks_uri,
    });
  });

  /* The mix-up defence: a document describing another issuer is refused. */
  it('refuses a document that names another issuer', () => {
    expect(
      parseDiscovery({ ...doc, issuer: 'https://evil.example.com/' }, ISSUER),
    ).toBeNull();
  });

  it('refuses plain-http endpoints off loopback', () => {
    expect(
      parseDiscovery(
        { ...doc, jwks_uri: 'http://auth.example.com/jwks/' },
        ISSUER,
      ),
    ).toBeNull();
  });

  it('drops private key material from a key set', () => {
    const k = keyPair('ed25519', 'k').jwk;
    expect(parseJwks({ keys: [k, { ...k, d: 'secret' }] })).toEqual([k]);
  });
});
