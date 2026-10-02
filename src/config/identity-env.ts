import { StrKey } from '@stellar/stellar-sdk';
import { isProviderUrl } from '@/common/oidc/oidc-core';
import { parseReturnUrls, returnUrlProblem } from '@/common/return-url';
import { parseAtRestKey } from '@/wallet-auth/backup-cipher';

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

/**
 * A comma list of ledger names: `public`, `testnet`, or both. Anything else is a
 * typo the parser would otherwise drop, leaving a ledger unserved with no sign.
 */
function requireNetworkList(env: Env, name: string): void {
  const raw = read(env, name);
  if (!raw) return;
  for (const entry of raw.split(',').map((s) => s.trim().toLowerCase())) {
    if (entry !== 'public' && entry !== 'testnet') {
      throw new Error(
        `${name} entry "${entry}" must be "public" or "testnet".`,
      );
    }
  }
}

function requireStellarSecret(env: Env, name: string): string {
  const value = read(env, name);
  if (!StrKey.isValidEd25519SecretSeed(value)) {
    throw new Error(`${name} must be a Stellar secret seed (S…).`);
  }
  return value;
}

/**
 * A sender is `MAIL_FROM` plus a transport — `MAIL_RESEND_API_KEY` or
 * `MAIL_SMTP_HOST`. Either half alone is refused: a from-address with nothing to
 * send it, or a transport that would send from nobody.
 */
function mailConfigured(env: Env): boolean {
  const from = Boolean(read(env, 'MAIL_FROM'));
  const transport = Boolean(
    read(env, 'MAIL_RESEND_API_KEY') || read(env, 'MAIL_SMTP_HOST'),
  );
  if (from !== transport) {
    throw new Error(
      'MAIL_FROM is set together with a transport (MAIL_RESEND_API_KEY or MAIL_SMTP_HOST), or not at all.',
    );
  }
  return from;
}

/** Two variables that only mean something together: both set, or neither. */
function pairConfigured(env: Env, a: string, b: string): boolean {
  const hasA = Boolean(read(env, a));
  const hasB = Boolean(read(env, b));
  if (hasA !== hasB)
    throw new Error(`${a} and ${b} are set together or not at all.`);
  return hasA;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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
  const mail = mailConfigured(env);
  const minting = pairConfigured(env, 'APISIX_ADMIN_URL', 'APISIX_ADMIN_KEY');
  if (minting && !isHttpUrl(read(env, 'APISIX_ADMIN_URL'))) {
    throw new Error(
      'APISIX_ADMIN_URL must be an http(s) URL, e.g. http://apisix:9180/apisix/admin.',
    );
  }
  // The email door needs both halves: a sender for the code and a way to mint
  // the keys the sign-in ends with.
  const emailDoor = mail && minting;
  const signInServed = Boolean(google || github || authentik || emailDoor);

  // The at-rest key for stored backups: required wherever a sign-in can store one,
  // and well-formed wherever it is set (a key that failed to parse would be a
  // backup that silently stops opening).
  const backupKey = read(env, 'WALLET_BACKUP_ENCRYPTION_KEY');
  if (signInServed && !backupKey) {
    throw new Error(
      'WALLET_BACKUP_ENCRYPTION_KEY is required whenever a wallet sign-in door is configured: ' +
        'it seals every stored backup at rest (openssl rand -base64 32).',
    );
  }
  for (const [name, value] of [
    ['WALLET_BACKUP_ENCRYPTION_KEY', backupKey],
    ...read(env, 'WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => ['WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS', v]),
  ]) {
    if (value && !parseAtRestKey(value)) {
      throw new Error(
        `${name} must be 32 bytes, in base64 or hex (openssl rand -base64 32).`,
      );
    }
  }

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
  // Refused whole rather than skipped entry by entry: a typo here is a wallet
  // whose sign-in sheet never closes, and an entry that would redirect anywhere
  // off the service's own domain is the one mistake this list exists to stop.
  for (const entry of parseReturnUrls(read(env, 'WALLET_AUTH_RETURN_URLS'))) {
    const problem = returnUrlProblem(entry);
    if (problem) {
      throw new Error(`WALLET_AUTH_RETURN_URLS entry "${entry}" ${problem}.`);
    }
  }

  requireNetworkList(env, 'WALLET_RECOVERY_SPONSOR_NETWORKS');
  requireNetworkList(env, 'RECOVERY_NETWORKS');

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
    // Nor the credential that mints accounts: a recovery server that could also
    // write the gateway is worth compromising for that alone.
    if (read(env, 'APISIX_ADMIN_KEY')) {
      throw new Error(
        'APISIX_ADMIN_KEY must not be set on a recovery server (RECOVERY_ROLE). ' +
          'Only the main deployment mints wallet keys.',
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

    const emailCodes =
      read(env, 'RECOVERY_EMAIL_CODES').toLowerCase() === 'true';
    if (emailCodes && !mail) {
      throw new Error(
        'RECOVERY_EMAIL_CODES=true needs MAIL_FROM and a transport (MAIL_RESEND_API_KEY or MAIL_SMTP_HOST): this server sends its own codes.',
      );
    }
    if (!oidc && !emailCodes) {
      throw new Error(
        'A recovery server needs a way to prove an inbox: RECOVERY_OIDC_ISSUER (+ AUDIENCES) ' +
          'for ID tokens, RECOVERY_EMAIL_CODES=true (+ MAIL_*) for its own emailed codes, or both.',
      );
    }
  }

  assertDistinct(env, [
    'APISIX_GATEWAY_SECRET',
    'WALLET_AUTH_SESSION_SECRET',
    'APISIX_ADMIN_KEY',
    'WALLET_BACKUP_ENCRYPTION_KEY',
    'RECOVERY_JWT_SECRET',
  ]);
}
