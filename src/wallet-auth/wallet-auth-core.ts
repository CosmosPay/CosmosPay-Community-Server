import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { WalletAuthMethod, WalletAuthProvider } from '@generated/prisma/client';
import { openJson, sealJson } from '@/common/sealed-box';
import {
  BACKUP_BOX_MAX_CHARS,
  BACKUP_MAX_ITERATIONS,
  BACKUP_MIN_ITERATIONS,
  SESSION_TTL_MS,
  SIGNED_AT_SKEW_MS,
} from '@/wallet-auth/wallet-auth.constants';

/**
 * The rules of the wallet's own sign-in, with nothing but `node:*` and the SDK.
 *
 * Everything here DECIDES something: whether a PKCE verifier matches, which email
 * a provider actually verified, whether a session token is still good, whether a
 * backup box is one the wallet could have produced, what exactly a signature has
 * to cover. None of it touches Prisma, the network or the config, so the spec
 * beside it reaches all of it — the service only wires these to storage.
 *
 * Ported from the developer platform's `src/lib/wallet-auth-core.ts`. Two things
 * in here are a CONTRACT with the wallet and must not drift: the two challenge
 * strings, which the wallet builds byte for byte in its own `src/lib/signIn.ts`,
 * and the shape of a backup box.
 */

/* ------------------------------- providers -------------------------------- */

/** The wire spelling of a provider, which is what the wallet sends. */
export const PROVIDER_WIRE = {
  [WalletAuthProvider.GOOGLE]: 'google',
  [WalletAuthProvider.GITHUB]: 'github',
} as const satisfies Record<WalletAuthProvider, string>;

export type ProviderWire = (typeof PROVIDER_WIRE)[WalletAuthProvider];

/**
 * A Map, not an object literal.
 *
 * The value comes off the wire, and an object literal answers `__proto__`,
 * `constructor` and `toString` from its prototype chain — so `providerFromWire`
 * returned a truthy non-provider for input a caller chose. A Map has no
 * prototype keys to inherit.
 */
const WIRE_TO_PROVIDER = new Map<string, WalletAuthProvider>([
  ['google', WalletAuthProvider.GOOGLE],
  ['github', WalletAuthProvider.GITHUB],
]);

/** The provider a wire value names, or null. Never throws on caller input. */
export function providerFromWire(value: string): WalletAuthProvider | null {
  if (typeof value !== 'string') return null;
  return WIRE_TO_PROVIDER.get(value.toLowerCase()) ?? null;
}

/** The method a finished provider sign-in records. */
export function methodOfProvider(
  provider: WalletAuthProvider,
): WalletAuthMethod {
  return provider === WalletAuthProvider.GOOGLE
    ? WalletAuthMethod.GOOGLE
    : WalletAuthMethod.GITHUB;
}

export interface ProviderEndpoints {
  authorize: string;
  token: string;
  scope: string;
  /** Where the access token is spent to read who the person is. */
  profile: string;
  /**
   * GitHub only: the verified-email list lives on its own endpoint, because the
   * profile's `email` field is whatever the person typed as public and carries
   * no verification at all.
   */
  emails?: string;
}

export const PROVIDER_ENDPOINTS: Record<WalletAuthProvider, ProviderEndpoints> =
  {
    [WalletAuthProvider.GOOGLE]: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      scope: 'openid email profile',
      profile: 'https://openidconnect.googleapis.com/v1/userinfo',
    },
    [WalletAuthProvider.GITHUB]: {
      authorize: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      // `user:email` is what exposes the VERIFIED flag; the public profile email
      // carries none.
      scope: 'read:user user:email',
      profile: 'https://api.github.com/user',
      emails: 'https://api.github.com/user/emails',
    },
  };

/**
 * Where a provider sends the person back.
 *
 * Registered with each provider exactly as this builds it, so `baseUrl` is the
 * public origin this service answers on — the gateway's, not the upstream's. A
 * redirect URI the provider does not hold verbatim is refused by the provider,
 * before anything here runs.
 *
 * Note the path differs from the developer platform's `/api/wallet/auth/...`.
 * Both have to be registered with Google and GitHub while both are serving.
 */
export function callbackUrl(
  baseUrl: string,
  provider: WalletAuthProvider,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/v1/wallet/auth/oauth/callback/${PROVIDER_WIRE[provider]}`;
}

/** The URL the wallet opens in a browser. */
export function authorizationUrl(
  provider: WalletAuthProvider,
  input: { clientId: string; redirectUri: string; state: string },
): string {
  const ep = PROVIDER_ENDPOINTS[provider];
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: ep.scope,
    state: input.state,
  });
  // Google: always show the account picker. Signing in to a WALLET with whichever
  // Google account the browser happened to have open is how somebody creates a
  // second wallet under the wrong email without ever being asked which one.
  if (provider === WalletAuthProvider.GOOGLE) q.set('prompt', 'select_account');
  if (provider === WalletAuthProvider.GITHUB) q.set('allow_signup', 'true');
  return `${ep.authorize}?${q.toString()}`;
}

/* --------------------------------- tokens --------------------------------- */

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/** An opaque, URL-safe random token. 32 bytes: nobody guesses it. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A uniform six-digit code. `randomInt`, never `Math.random`. */
export function sixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** The form an email is stored and looked up in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/* ---------------------------------- PKCE ---------------------------------- */

/**
 * RFC 7636 S256: does `verifier` hash to `challenge`?
 *
 * The verifier is the whole credential of the provider flow. The `state` travels
 * through a browser and anyone who sees it can poll; only the device that opened
 * the handshake holds the verifier. Compared in constant time for the usual
 * reason, even though the challenge is not secret — there is no cost to doing it
 * right, and a future caller may pass something that is.
 */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const got = Buffer.from(
    createHash('sha256').update(verifier, 'ascii').digest('base64url'),
  );
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

/* ------------------------------- identities ------------------------------- */

/** Who a provider says this is — only ever with an email it has VERIFIED. */
export interface ProviderIdentity {
  email: string;
  name: string | null;
  avatar: string | null;
  subject: string;
}

export type IdentityFailure = 'email_unverified' | 'profile_invalid';

export type IdentityResult =
  | { ok: true; identity: ProviderIdentity }
  | { ok: false; error: IdentityFailure };

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};

/**
 * Google's OIDC userinfo, reduced to what may be trusted.
 *
 * `email_verified` has to be literally `true`. A Google Workspace domain can hand
 * out addresses nobody has confirmed, and an account is looked up BY EMAIL — so
 * an unverified one is a way to sign in as somebody else's existing account.
 */
export function googleIdentity(userinfo: unknown): IdentityResult {
  const u = (userinfo ?? {}) as Record<string, unknown>;
  const email = str(u.email)?.toLowerCase() ?? null;
  const subject = str(u.sub);
  if (!email || !subject) return { ok: false, error: 'profile_invalid' };
  if (u.email_verified !== true)
    return { ok: false, error: 'email_unverified' };
  return {
    ok: true,
    identity: {
      email,
      name: str(u.name),
      avatar: httpsUrl(u.picture),
      subject,
    },
  };
}

/**
 * GitHub's user plus its email list, reduced the same way.
 *
 * The profile's own `email` field is whatever the person typed as public and
 * carries no verification at all, so it is never used. The primary address wins
 * when it is verified; otherwise the first verified one; otherwise there is no
 * identity to sign in with.
 */
export function githubIdentity(user: unknown, emails: unknown): IdentityResult {
  const u = (user ?? {}) as Record<string, unknown>;
  const subject =
    typeof u.id === 'number' || typeof u.id === 'string' ? String(u.id) : null;
  if (!subject) return { ok: false, error: 'profile_invalid' };
  const list = Array.isArray(emails)
    ? (emails as Record<string, unknown>[])
    : [];
  const verified = list.filter((e) => e && e.verified === true && str(e.email));
  const chosen = verified.find((e) => e.primary === true) ?? verified[0];
  if (!chosen) return { ok: false, error: 'email_unverified' };
  return {
    ok: true,
    identity: {
      email: (str(chosen.email) as string).toLowerCase(),
      name: str(u.name) ?? str(u.login),
      avatar: httpsUrl(u.avatar_url),
      subject,
    },
  };
}

/** A display name when the provider gave none. */
export function fallbackName(email: string, name?: string | null): string {
  return name?.trim() || email.split('@')[0] || 'Cosmos user';
}

/* ----------------------------- session token ------------------------------ */

/** What a completed sign-in is: an email proven one way or another. */
export interface WalletAuthIdentity {
  email: string;
  name: string | null;
  avatar: string | null;
  method: WalletAuthMethod;
}

interface SessionPayload extends WalletAuthIdentity {
  v: 1;
  exp: number;
}

/** Part of the sealing key's derivation, so no other sealed box opens as a session. */
const SESSION_PURPOSE = 'wallet-auth-session';

/**
 * The token a sign-in hands the wallet.
 *
 * Stateless and sealed: AES-GCM under a key only this service derives, so it
 * cannot be forged or edited, and nothing about it sits in a table. The cost of
 * that is that it cannot be revoked — which is why it is short-lived and why
 * exactly one route accepts it.
 */
export function issueSessionToken(
  identity: WalletAuthIdentity,
  secret: string,
  now = Date.now(),
): string {
  const payload: SessionPayload = {
    v: 1,
    ...identity,
    exp: now + SESSION_TTL_MS,
  };
  return sealJson(payload, secret, SESSION_PURPOSE);
}

/** The identity a token carries, or null when it is forged, edited, malformed or stale. */
export function readSessionToken(
  token: string,
  secret: string,
  now = Date.now(),
): WalletAuthIdentity | null {
  const p = openJson<SessionPayload>(token, secret, SESSION_PURPOSE);
  if (!p || p.v !== 1 || typeof p.exp !== 'number' || p.exp < now) return null;
  if (typeof p.email !== 'string' || !p.email) return null;
  return {
    email: p.email,
    name: p.name ?? null,
    avatar: p.avatar ?? null,
    method: p.method,
  };
}

/* ------------------------------- signatures ------------------------------- */

/**
 * The challenge a device signs to finish a sign-in: it binds the proven email to
 * the address whose key the device holds, at a moment.
 *
 * MUST match the wallet byte for byte (`finishMessage` in its `src/lib/signIn.ts`)
 * and the developer platform's copy. All three pin the same literal in their own
 * tests; change one and no sign-in can finish.
 *
 * A distinct first line from every other message this service verifies, so a
 * signature made for one flow is worth nothing in another.
 */
export function finishMessage(
  email: string,
  stellarAddress: string,
  signedAt: string,
): string {
  return (
    `Cosmos Pay Wallet sign-in\n` +
    `email: ${normalizeEmail(email)}\n` +
    `account: ${stellarAddress}\n` +
    `at: ${signedAt}`
  );
}

/**
 * The challenge for replacing a backup's box — what `changePassword` on the
 * device sends.
 *
 * It covers the box's HASH, so a signature over one box cannot be replayed to
 * store another. Same contract as above: the wallet builds this string itself.
 */
export function backupMessage(
  stellarAddress: string,
  box: string,
  signedAt: string,
): string {
  return (
    `Cosmos Pay Wallet backup\n` +
    `account: ${stellarAddress}\n` +
    `box: ${sha256Hex(box)}\n` +
    `at: ${signedAt}`
  );
}

/**
 * Does `signatureBase64` prove that `address` produced `message`?
 *
 * Over the message's raw UTF-8 bytes, NOT over a digest — deliberately, and
 * unlike `@/aliases/alias-signing`, which frames a digest because it verifies
 * bytes a caller chose. These two challenges are fixed formats that begin with a
 * line no Stellar transaction envelope can, which is what makes signing them
 * safe. The wallet's `signChallenge` signs the same bytes and says the same
 * thing in its own comment; do not "unify" the two schemes.
 *
 * Returns a boolean and never throws: every input arrives from the wire, and a
 * verifier that crashes on junk is a denial of service on the sign-in route.
 */
export function verifyWalletSignature(
  address: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const sig = Buffer.from(signatureBase64, 'base64');
    // A wrong-length buffer is what `Buffer.from(…, 'base64')` silently
    // produces from junk input, and the SDK throws on it rather than
    // returning false.
    if (sig.length !== 64) return false;
    return Keypair.fromPublicKey(address).verify(
      Buffer.from(message, 'utf8'),
      sig,
    );
  } catch {
    return false;
  }
}

/**
 * Is `value` a syntactically valid, correctly checksummed Stellar account id?
 *
 * The checksum matters, not just the shape: an address with a typo in it decodes
 * to 32 perfectly plausible bytes, and verifying against those fails as "bad
 * signature" — which sends whoever is debugging it somewhere else entirely.
 */
export function isStellarAddress(value: string): boolean {
  try {
    Keypair.fromPublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a signed ISO timestamp close enough to now to accept?
 *
 * The format is pinned as well as the window: a parser that accepts anything
 * `Date.parse` understands accepts strings carrying their own offset, and "the
 * same instant written differently" is not what a replay window should have to
 * reason about.
 */
export function signedAtFresh(signedAt: string, now = Date.now()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(signedAt))
    return false;
  const t = Date.parse(signedAt);
  return Number.isFinite(t) && Math.abs(now - t) <= SIGNED_AT_SKEW_MS;
}

/* --------------------------------- backup --------------------------------- */

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Is this a box the wallet could have produced?
 *
 * The wallet's sealed-box JSON — `v: 2`, a salt, an IV, the ciphertext and the
 * PBKDF2 cost — and nothing that would let it sit here as something weaker.
 * Structure only: whether it OPENS is a question for a password this service
 * never sees.
 */
export function isBackupBox(box: string): boolean {
  if (typeof box !== 'string' || !box || box.length > BACKUP_BOX_MAX_CHARS)
    return false;
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(box) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  if (b.v !== 2) return false;
  for (const k of ['salt', 'iv', 'data']) {
    if (typeof b[k] !== 'string' || !B64.test(b[k])) return false;
  }
  // 16-byte salt and 12-byte IV, as the wallet writes them.
  if (Buffer.from(b.salt as string, 'base64').length < 16) return false;
  if (Buffer.from(b.iv as string, 'base64').length !== 12) return false;
  const iter = b.iter;
  return (
    Number.isInteger(iter) &&
    (iter as number) >= BACKUP_MIN_ITERATIONS &&
    (iter as number) <= BACKUP_MAX_ITERATIONS
  );
}
