import { Keypair, Networks } from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE_PUBLIC } from '@/config/config.constants';
import { assertIdentityConfigConsistent } from '@/config/identity-env';

const secret = (c: string) => c.repeat(40);

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
          WALLET_AUTH_CONSOLE_URL: 'https://console.example.com',
          WALLET_AUTH_CONSOLE_SECRET: secret('c'),
          WALLET_AUTH_SESSION_SECRET: secret('s'),
        }),
      ),
    ).toThrow(/must not be set on a recovery server/);
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
