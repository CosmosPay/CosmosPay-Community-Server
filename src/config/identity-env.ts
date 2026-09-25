import { StrKey } from '@stellar/stellar-sdk';
import { isProviderUrl } from '@/common/oidc/oidc-core';

/**
 * Boot-time rules for the wallet sign-in and the recovery servers.
 *
 * Every one of these is a secret doing ONE job, checked at boot so a deployment
 * that would run with a shared or missing one refuses to start instead of
 * running quietly weaker. Three of them used to fall back to
 * `APISIX_GATEWAY_SECRET`, and the recovery servers verified identities with an
 * HMAC secret the sign-in server also held — so a single leaked value was a
 * gateway bypass, a forged sign-in and a forged recovery identity at once.
 *
 * Reads the RAW environment, not the validated class: these rules are about how
 * variables relate to each other, which a per-field decorator cannot express.
 */

const MIN_SECRET_CHARS = 32;

const PLACEHOLDER =
  /replace[-_ ]?(with|me)|change[-_ ]?me|your[-_ ]?secret|placeholder/i;

type Env = Record<string, unknown>;

function read(env: Env, name: string): string {
  const v = env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function requireSecret(env: Env, name: string, why: string): string {
  const value = read(env, name);
  if (!value) throw new Error(`${name} is required ${why}.`);
  if (value.length < MIN_SECRET_CHARS) {
    throw new Error(
      `${name} must be at least ${MIN_SECRET_CHARS} characters (openssl rand -hex 32).`,
    );
  }
  if (PLACEHOLDER.test(value))
    throw new Error(`${name} is still a placeholder.`);
  return value;
}

/** No two of these may hold the same value: each one guards something different. */
function assertDistinct(env: Env, names: string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const value = read(env, name);
    if (!value) continue;
    const other = seen.get(value);
    if (other) {
      throw new Error(
        `${name} and ${other} hold the same value. Each one guards a different ` +
          'boundary, and a value shared between them is one leak that breaks both.',
      );
    }
    seen.set(value, name);
  }
}

function requireStellarSecret(env: Env, name: string): string {
  const value = read(env, name);
  if (!StrKey.isValidEd25519SecretSeed(value)) {
    throw new Error(`${name} must be a Stellar secret seed (S…).`);
  }
  return value;
}

/** The OIDC trio is whole or absent. */
function oidcConfigured(
  env: Env,
  prefix: string,
  needsSecret: boolean,
): boolean {
  const issuer = read(env, `${prefix}_ISSUER`);
  const clientId = read(env, `${prefix}_CLIENT_ID`);
  const clientSecret = needsSecret
    ? read(env, `${prefix}_CLIENT_SECRET`)
    : 'n/a';
  const any =
    issuer || clientId || (needsSecret && read(env, `${prefix}_CLIENT_SECRET`));
  if (!any) return false;
  if (!issuer || !clientId || !clientSecret) {
    throw new Error(
      `${prefix}_ISSUER, ${prefix}_CLIENT_ID${needsSecret ? ` and ${prefix}_CLIENT_SECRET` : ''} ` +
        'are set together or not at all.',
    );
  }
  if (!isProviderUrl(issuer))
    throw new Error(`${prefix}_ISSUER must be an https URL.`);
  return true;
}

export function assertIdentityConfigConsistent(env: Env): void {
  /* ------------------------------ wallet sign-in ----------------------------- */
  const google =
    read(env, 'WALLET_GOOGLE_CLIENT_ID') &&
    read(env, 'WALLET_GOOGLE_CLIENT_SECRET');
  const github =
    read(env, 'WALLET_GITHUB_CLIENT_ID') &&
    read(env, 'WALLET_GITHUB_CLIENT_SECRET');
  const authentik = oidcConfigured(env, 'WALLET_AUTH_OIDC', true);
  const consoleUrl = read(env, 'WALLET_AUTH_CONSOLE_URL');
  const signInServed = Boolean(google || github || authentik || consoleUrl);

  if (signInServed) {
    requireSecret(
      env,
      'WALLET_AUTH_SESSION_SECRET',
      'whenever a wallet sign-in door is configured: it seals the token that can create an account',
    );
    if (
      !read(env, 'WALLET_AUTH_PUBLIC_BASE_URL') &&
      (google || github || authentik)
    ) {
      throw new Error(
        'WALLET_AUTH_PUBLIC_BASE_URL is required for a provider sign-in: the redirect URI is built from it.',
      );
    }
  }
  if (consoleUrl) {
    requireSecret(
      env,
      'WALLET_AUTH_CONSOLE_SECRET',
      'when WALLET_AUTH_CONSOLE_URL is set: it proves a call to the console came from this service',
    );
  }

  const sponsor = read(env, 'WALLET_RECOVERY_SPONSOR_SECRET');
  if (sponsor) {
    requireStellarSecret(env, 'WALLET_RECOVERY_SPONSOR_SECRET');
    if (!signInServed) {
      throw new Error(
        'WALLET_RECOVERY_SPONSOR_SECRET needs the wallet sign-in: a sponsored setup is only paid for someone who just signed in.',
      );
    }
  }

  /* ------------------------------ recovery server ---------------------------- */
  const role = read(env, 'RECOVERY_ROLE');
  if (role) {
    if (role !== 'a' && role !== 'b')
      throw new Error('RECOVERY_ROLE must be "a" or "b".');

    // The operator's money must never sit on the two hosts whose independence is
    // the whole design: a recovery server that could also spend is a recovery
    // server worth compromising for its own sake.
    if (sponsor) {
      throw new Error(
        'WALLET_RECOVERY_SPONSOR_SECRET must not be set on a recovery server (RECOVERY_ROLE). ' +
          'Sponsor recovery setups from the main deployment.',
      );
    }

    const base = read(env, 'RECOVERY_PUBLIC_BASE_URL');
    if (!isProviderUrl(base)) {
      throw new Error(
        'RECOVERY_PUBLIC_BASE_URL must be the https origin (plus gateway entry) clients reach this server on.',
      );
    }
    if (!read(env, 'RECOVERY_HOME_DOMAIN')) {
      throw new Error(
        'RECOVERY_HOME_DOMAIN is required, and must be the SAME on both recovery servers.',
      );
    }
    const master = requireStellarSecret(env, 'RECOVERY_SIGNER_MASTER');
    const sep10 = requireStellarSecret(env, 'RECOVERY_SEP10_SIGNING_SECRET');
    if (master === sep10) {
      throw new Error(
        'RECOVERY_SEP10_SIGNING_SECRET must differ from RECOVERY_SIGNER_MASTER: one signs logins, the other derives on-chain signers.',
      );
    }
    requireSecret(
      env,
      'RECOVERY_JWT_SECRET',
      'on a recovery server: it signs the tokens every SEP-30 route accepts',
    );

    const oidc = read(env, 'RECOVERY_OIDC_ISSUER');
    const audiences = read(env, 'RECOVERY_OIDC_AUDIENCES');
    if (Boolean(oidc) !== Boolean(audiences)) {
      throw new Error(
        'RECOVERY_OIDC_ISSUER and RECOVERY_OIDC_AUDIENCES are set together or not at all.',
      );
    }
    if (oidc && !isProviderUrl(oidc))
      throw new Error('RECOVERY_OIDC_ISSUER must be an https URL.');

    const mailUrl = read(env, 'RECOVERY_EMAIL_DELIVERY_URL');
    if (mailUrl) {
      if (!isProviderUrl(mailUrl))
        throw new Error('RECOVERY_EMAIL_DELIVERY_URL must be an https URL.');
      requireSecret(
        env,
        'RECOVERY_EMAIL_DELIVERY_SECRET',
        'when RECOVERY_EMAIL_DELIVERY_URL is set',
      );
    }
    if (!oidc && !mailUrl) {
      throw new Error(
        'A recovery server needs a way to prove an inbox: RECOVERY_OIDC_ISSUER (+ AUDIENCES) ' +
          'for ID tokens, RECOVERY_EMAIL_DELIVERY_URL for its own emailed codes, or both.',
      );
    }
  }

  assertDistinct(env, [
    'APISIX_GATEWAY_SECRET',
    'WALLET_AUTH_SESSION_SECRET',
    'WALLET_AUTH_CONSOLE_SECRET',
    'RECOVERY_JWT_SECRET',
    'RECOVERY_EMAIL_DELIVERY_SECRET',
  ]);
}
