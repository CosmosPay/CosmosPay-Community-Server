import { Keypair, Networks } from '@stellar/stellar-sdk';
import {
  NETWORK_PASSPHRASE_PUBLIC,
  NETWORK_PASSPHRASE_TESTNET,
} from '@/config/config.constants';
import { assertIdentityConfigConsistent } from '@/config/identity-env';

const secret = (c: string) => c.repeat(40);
/** A well-formed at-rest key for stored backups: 32 bytes, base64. */
const BACKUP_KEY = Buffer.alloc(32, 7).toString('base64');

function recoveryServer(over: Record<string, string> = {}) {
  return {
    APISIX_GATEWAY_SECRET: secret('g'),
    RECOVERY_ROLE: 'a',
    RECOVERY_PUBLIC_BASE_URL: 'https://recovery-a.example.com/cosmos-api',
    RECOVERY_HOME_DOMAIN: 'example.com',
    RECOVERY_SIGNER_MASTER: Keypair.random().secret(),
    RECOVERY_SEP10_SIGNING_SECRET: Keypair.random().secret(),
    RECOVERY_JWT_SECRET: secret('r'),
    RECOVERY_OIDC_ISSUER: 'https://auth.example.com/application/o/wallet/',
    RECOVERY_OIDC_AUDIENCES: 'wallet-client',
    ...over,
  };
}

describe('assertIdentityConfigConsistent', () => {
  it('pins the public passphrase constant to the SDK', () => {
    expect(NETWORK_PASSPHRASE_PUBLIC).toBe(Networks.PUBLIC);
    expect(NETWORK_PASSPHRASE_TESTNET).toBe(Networks.TESTNET);
  });

  it('lets a deployment with no sign-in and no recovery boot untouched', () => {
    expect(() =>
      assertIdentityConfigConsistent({ APISIX_GATEWAY_SECRET: secret('g') }),
    ).not.toThrow();
  });

  /* It used to fall back to the gateway secret, which the platform also holds. */
  it('requires a session secret of its own once a sign-in door exists', () => {
    const env = {
      APISIX_GATEWAY_SECRET: secret('g'),
      WALLET_GOOGLE_CLIENT_ID: 'id',
      WALLET_GOOGLE_CLIENT_SECRET: 'sec',
      WALLET_AUTH_PUBLIC_BASE_URL: 'https://api.example.com/cosmos-api',
      WALLET_BACKUP_ENCRYPTION_KEY: BACKUP_KEY,
    };
    expect(() => assertIdentityConfigConsistent(env)).toThrow(
      /WALLET_AUTH_SESSION_SECRET/,
    );
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_AUTH_SESSION_SECRET: secret('g'),
      }),
    ).toThrow(/same value/);
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_AUTH_SESSION_SECRET: secret('s'),
      }),
    ).not.toThrow();
  });

  it('takes the Authentik trio whole or not at all', () => {
    expect(() =>
      assertIdentityConfigConsistent({
        APISIX_GATEWAY_SECRET: secret('g'),
        WALLET_AUTH_OIDC_ISSUER:
          'https://auth.example.com/application/o/wallet/',
      }),
    ).toThrow(/together/);
  });

  /* A return URL that could redirect anywhere is an open redirect, not a typo. */
  it('refuses a return URL the callback must never redirect to', () => {
    const env = { APISIX_GATEWAY_SECRET: secret('g') };
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_AUTH_RETURN_URLS:
          'cosmoswallet://auth/done, http://127.0.0.1/auth/done',
      }),
    ).not.toThrow();
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_AUTH_RETURN_URLS:
          'cosmoswallet://auth/done,http://evil.example.com/done',
      }),
    ).toThrow(
      /WALLET_AUTH_RETURN_URLS entry "http:\/\/evil.example.com\/done"/,
    );
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_AUTH_RETURN_URLS: 'javascript://x/alert(1)',
      }),
    ).toThrow(/javascript/);
  });

  it('boots a well-formed recovery server', () => {
    expect(() =>
      assertIdentityConfigConsistent(recoveryServer()),
    ).not.toThrow();
  });

  it('refuses a recovery server with no way to prove an inbox', () => {
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({
          RECOVERY_OIDC_ISSUER: '',
          RECOVERY_OIDC_AUDIENCES: '',
        }),
      ),
    ).toThrow(/prove an inbox/);
  });

  it('refuses one key doing both jobs', () => {
    const key = Keypair.random().secret();
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({
          RECOVERY_SIGNER_MASTER: key,
          RECOVERY_SEP10_SIGNING_SECRET: key,
        }),
      ),
    ).toThrow(/must differ/);
  });

  it('refuses a recovery JWT secret shared with the gateway', () => {
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({ RECOVERY_JWT_SECRET: secret('g') }),
      ),
    ).toThrow(/same value/);
  });

  /* The operator's money never sits on the two hosts whose independence is the design. */
  it('refuses the sponsor key on a recovery server', () => {
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({
          WALLET_RECOVERY_SPONSOR_SECRET: Keypair.random().secret(),
          MAIL_RESEND_API_KEY: 're_test',
          MAIL_FROM: 'wallet@example.com',
          APISIX_ADMIN_URL: 'http://apisix:9180/apisix/admin',
          APISIX_ADMIN_KEY: secret('k'),
          WALLET_AUTH_SESSION_SECRET: secret('s'),
          WALLET_BACKUP_ENCRYPTION_KEY: BACKUP_KEY,
        }),
      ),
    ).toThrow(/must not be set on a recovery server/);
  });

  /* Nor the credential that mints accounts. */
  it('refuses the APISIX admin key on a recovery server', () => {
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({
          APISIX_ADMIN_URL: 'http://apisix:9180/apisix/admin',
          APISIX_ADMIN_KEY: secret('k'),
        }),
      ),
    ).toThrow(/APISIX_ADMIN_KEY must not be set on a recovery server/);
  });

  it('needs a sender for a recovery server that emails its own codes', () => {
    const emailOnly = {
      RECOVERY_OIDC_ISSUER: '',
      RECOVERY_OIDC_AUDIENCES: '',
      RECOVERY_EMAIL_CODES: 'true',
    };
    expect(() =>
      assertIdentityConfigConsistent(recoveryServer(emailOnly)),
    ).toThrow(/MAIL_FROM/);
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({
          ...emailOnly,
          MAIL_RESEND_API_KEY: 're_test',
          MAIL_FROM: 'recovery-a@example.com',
        }),
      ),
    ).not.toThrow();
  });

  it('takes the mail and admin pairs whole or not at all', () => {
    const base = { APISIX_GATEWAY_SECRET: secret('g') };
    expect(() =>
      assertIdentityConfigConsistent({ ...base, MAIL_FROM: 'a@example.com' }),
    ).toThrow(/MAIL_FROM is set together/);
    expect(() =>
      assertIdentityConfigConsistent({
        ...base,
        MAIL_SMTP_HOST: 'smtp.example.com',
      }),
    ).toThrow(/MAIL_FROM is set together/);
    expect(() =>
      assertIdentityConfigConsistent({
        ...base,
        MAIL_SMTP_HOST: 'smtp.example.com',
        MAIL_FROM: 'a@example.com',
      }),
    ).not.toThrow();
    expect(() =>
      assertIdentityConfigConsistent({
        ...base,
        APISIX_ADMIN_KEY: secret('k'),
      }),
    ).toThrow(/set together/);
  });

  /* The email door needs both: a sender for the code and a way to mint keys. */
  it('opens the email door, and requires its session secret, only with both halves', () => {
    const base = {
      APISIX_GATEWAY_SECRET: secret('g'),
      MAIL_RESEND_API_KEY: 're_test',
      MAIL_FROM: 'wallet@example.com',
      WALLET_BACKUP_ENCRYPTION_KEY: BACKUP_KEY,
    };
    expect(() => assertIdentityConfigConsistent(base)).not.toThrow();
    expect(() =>
      assertIdentityConfigConsistent({
        ...base,
        APISIX_ADMIN_URL: 'http://apisix:9180/apisix/admin',
        APISIX_ADMIN_KEY: secret('k'),
      }),
    ).toThrow(/WALLET_AUTH_SESSION_SECRET/);
    expect(() =>
      assertIdentityConfigConsistent({
        ...base,
        APISIX_ADMIN_URL: 'http://apisix:9180/apisix/admin',
        APISIX_ADMIN_KEY: secret('g'),
        WALLET_AUTH_SESSION_SECRET: secret('s'),
      }),
    ).toThrow(/same value/);
  });

  /* Every stored backup is sealed at rest under it; a sign-in cannot run without one. */
  it('requires a well-formed backup encryption key wherever a sign-in door exists', () => {
    const env = {
      APISIX_GATEWAY_SECRET: secret('g'),
      WALLET_GOOGLE_CLIENT_ID: 'id',
      WALLET_GOOGLE_CLIENT_SECRET: 'sec',
      WALLET_AUTH_PUBLIC_BASE_URL: 'https://api.example.com/cosmos-api',
      WALLET_AUTH_SESSION_SECRET: secret('s'),
    };
    expect(() => assertIdentityConfigConsistent(env)).toThrow(
      /WALLET_BACKUP_ENCRYPTION_KEY is required/,
    );
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_BACKUP_ENCRYPTION_KEY: 'short',
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_BACKUP_ENCRYPTION_KEY: BACKUP_KEY,
        WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS: 'nope',
      }),
    ).toThrow(/WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS/);
    expect(() =>
      assertIdentityConfigConsistent({
        ...env,
        WALLET_BACKUP_ENCRYPTION_KEY: BACKUP_KEY,
      }),
    ).not.toThrow();
  });

  it('refuses a plain-http public base', () => {
    expect(() =>
      assertIdentityConfigConsistent(
        recoveryServer({
          RECOVERY_PUBLIC_BASE_URL: 'http://recovery-a.example.com',
        }),
      ),
    ).toThrow(/RECOVERY_PUBLIC_BASE_URL/);
  });
});
