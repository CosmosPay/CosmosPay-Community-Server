import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  WalletAuthHandshakeStatus,
  WalletAuthMethod,
  WalletAuthProvider,
  WalletLoginCodeStatus,
} from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { OidcService } from '@/common/oidc/oidc.service';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { WalletAuthService } from '@/wallet-auth/wallet-auth.service';
import {
  finishMessage,
  issueSessionToken,
  recoverySetupMessage,
  sha256Hex,
} from '@/wallet-auth/wallet-auth-core';
import { openJson, sealJson } from '@/common/sealed-box';

/** How the service seals an ID token for the minutes it waits in a row. */
const ID_TOKEN_PURPOSE = 'wallet-auth-id-token';

/*
 * Authentik as the sign-in's identity provider, the ID token it hands the
 * recovery servers, and the two things a RECOVERED account needs from this
 * service: a finish and a backup signed by the key that replaced its master.
 */

const ADDRESS = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const SIGNED_AT = '2026-01-02T03:04:05Z';
const NOW = Date.parse(SIGNED_AT);
const EMAIL = 'ada@example.com';
const SESSION_SECRET = 'a-server-secret-long-enough-to-be-real';
const TESTNET = 'Test SDF Network ; September 2015';

const OIDC = {
  issuer: 'https://auth.example.com/application/o/wallet/',
  clientId: 'wallet-client',
  clientSecret: 'wallet-client-secret',
};
const DISCOVERY = {
  issuer: OIDC.issuer,
  authorizationEndpoint: 'https://auth.example.com/application/o/authorize/',
  tokenEndpoint: 'https://auth.example.com/application/o/token/',
  jwksUri: 'https://auth.example.com/application/o/wallet/jwks/',
};

const SETTINGS = {
  publicBaseUrl: 'https://api.example.com',
  sessionSecret: SESSION_SECRET,
  consoleUrl: 'https://console.example.com',
  consoleSecret: 'console-secret',
  google: { clientId: '', clientSecret: '' },
  github: { clientId: '', clientSecret: '' },
  oidc: OIDC,
  signersHorizonUrl: 'https://horizon.example.com',
  sponsor: {
    secret: '',
    networkPassphrase: TESTNET,
    horizonUrl: 'https://horizon.example.com',
  },
  timeoutMs: 1000,
  sweep: { enabled: true, intervalMs: 60_000 },
};

type Mocked = Record<string, jest.Mock>;

function makeService(settings: Partial<typeof SETTINGS> = {}) {
  const prisma = {
    walletAuthHandshake: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    } as Mocked,
    walletLoginCode: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    } as Mocked,
    walletAccount: { findUnique: jest.fn(), upsert: jest.fn() } as Mocked,
    walletBackup: {
      findFirst: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    } as Mocked,
  };
  const config = {
    get: jest.fn().mockReturnValue({ ...SETTINGS, ...settings }),
  } as unknown as ConfigService<AppConfig, true>;
  const oidc = { verify: jest.fn(), discover: jest.fn() };
  const service = new WalletAuthService(
    prisma as unknown as PrismaService,
    config,
    oidc as unknown as OidcService,
  );
  return { service, prisma, oidc };
}

function answer(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const sign = (key: Keypair, message: string) =>
  Buffer.from(key.sign(Buffer.from(message, 'utf8'))).toString('base64');

const session = (method: WalletAuthMethod = WalletAuthMethod.AUTHENTIK) =>
  issueSessionToken(
    { email: EMAIL, name: 'Ada', avatar: null, method },
    SESSION_SECRET,
    NOW,
  );

describe('WalletAuthService — Authentik and the recovery identity', () => {
  const verifier = 'a-verifier-the-device-kept-to-itself-0000000';
  const challenge = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    global.fetch = jest
      .fn()
      .mockResolvedValue(answer({ organizationId: 'org_1', keys: {} }));
  });
  afterEach(() => jest.useRealTimers());

  function authorized(idToken: string | null) {
    return {
      state: 'st',
      provider: WalletAuthProvider.AUTHENTIK,
      codeChallenge: challenge,
      status: WalletAuthHandshakeStatus.AUTHORIZED,
      email: EMAIL,
      name: 'Ada',
      avatar: null,
      subject: 'ak-1',
      idToken,
      expiresAt: new Date(NOW + 60_000),
    };
  }

  it('offers Authentik first when it is configured', () => {
    const { service } = makeService();
    expect(service.providers().providers[0]).toBe('authentik');
  });

  it('does not offer Authentik without an issuer', () => {
    const { service } = makeService({
      oidc: { issuer: '', clientId: 'x', clientSecret: 'y' },
    });
    expect(service.providers().providers).not.toContain('authentik');
  });

  it('opens a sign-in with its own PKCE pair and a nonce, held server-side', async () => {
    const { service, prisma, oidc } = makeService();
    oidc.discover.mockResolvedValue(DISCOVERY);
    prisma.walletAuthHandshake.create.mockResolvedValue({});

    const started = await service.startOauth({
      provider: 'authentik',
      codeChallenge: 'c'.repeat(43),
      codeChallengeMethod: 'S256',
    });

    const stored = prisma.walletAuthHandshake.create.mock.calls[0][0].data;
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorizationEndpoint);
    expect(url.searchParams.get('nonce')).toBe(stored.nonce);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The provider sees the S256 of the verifier this service keeps — never the
    // verifier itself, and never the DEVICE's challenge.
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update(stored.providerVerifier, 'ascii')
        .digest('base64url'),
    );
    expect(url.searchParams.get('code_challenge')).not.toBe('c'.repeat(43));
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/v1/wallet/auth/oauth/callback/authentik',
    );
  });

  it('reads the identity from the VERIFIED ID token, bound to the handshake nonce', async () => {
    const { service, prisma, oidc } = makeService();
    oidc.discover.mockResolvedValue(DISCOVERY);
    prisma.walletAuthHandshake.findUnique.mockResolvedValue({
      state: 'st',
      provider: WalletAuthProvider.AUTHENTIK,
      status: WalletAuthHandshakeStatus.PENDING,
      providerVerifier: 'pv',
      nonce: 'the-nonce',
      expiresAt: new Date(NOW + 60_000),
    });
    prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        answer({ access_token: 'at', id_token: 'the.id.token' }),
      );
    oidc.verify.mockResolvedValue({
      ok: true,
      claims: {
        email: EMAIL,
        name: 'Ada',
        picture: null,
        sub: 'ak-1',
        exp: 0,
        iat: 0,
        iss: OIDC.issuer,
        authTime: 0,
      },
    });

    expect(
      await service.handleCallback('authentik', { code: 'c', state: 'st' }),
    ).toEqual({ ok: true, reason: 'ok' });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(DISCOVERY.tokenEndpoint);
    expect(String(init.body)).toContain('code_verifier=pv');
    expect(oidc.verify.mock.calls[0][1]).toMatchObject({
      nonce: 'the-nonce',
      audiences: ['wallet-client'],
    });
    expect(
      prisma.walletAuthHandshake.updateMany.mock.calls[0][0],
    ).toMatchObject({
      where: { state: 'st', status: WalletAuthHandshakeStatus.PENDING },
      data: {
        status: WalletAuthHandshakeStatus.AUTHORIZED,
        email: EMAIL,
        providerVerifier: null,
        nonce: null,
      },
    });
    // Sealed at rest: a read of the table is not a usable recovery credential.
    const stored = prisma.walletAuthHandshake.updateMany.mock.calls[0][0].data
      .idToken as string;
    expect(stored).not.toContain('the.id.token');
    expect(openJson(stored, SESSION_SECRET, ID_TOKEN_PURPOSE)).toEqual({
      idToken: 'the.id.token',
    });
  });

  it('fails the handshake when the ID token does not verify', async () => {
    const { service, prisma, oidc } = makeService();
    oidc.discover.mockResolvedValue(DISCOVERY);
    prisma.walletAuthHandshake.findUnique.mockResolvedValue({
      state: 'st',
      provider: WalletAuthProvider.AUTHENTIK,
      status: WalletAuthHandshakeStatus.PENDING,
      providerVerifier: 'pv',
      nonce: 'the-nonce',
      expiresAt: new Date(NOW + 60_000),
    });
    prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
    global.fetch = jest
      .fn()
      .mockResolvedValue(answer({ access_token: 'at', id_token: 'forged' }));
    oidc.verify.mockResolvedValue({ ok: false, error: 'wrong_nonce' });

    const outcome = await service.handleCallback('authentik', {
      code: 'c',
      state: 'st',
    });

    expect(outcome.ok).toBe(false);
    expect(
      prisma.walletAuthHandshake.updateMany.mock.calls[0][0].data.status,
    ).toBe(WalletAuthHandshakeStatus.FAILED);
  });

  it("never releases the ID token on the provider's word alone", async () => {
    const { service, prisma } = makeService();
    prisma.walletAuthHandshake.findUnique.mockResolvedValue(
      authorized('the.id.token'),
    );
    prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletAccount.findUnique.mockResolvedValue(null);

    const result = await service.claimOauth({
      state: 'st',
      codeVerifier: verifier,
    });

    expect(result.status).toBe('ready');
    expect(result).not.toHaveProperty('idToken');
  });

  /* A stranger can send someone an authorization link and collect what it
     proves; for a recovery that is a wallet. The inbox is what decides. */
  it('routes a RECOVERY claim through the inbox even for an email with no account', async () => {
    const { service, prisma } = makeService();
    prisma.walletAuthHandshake.findUnique.mockResolvedValue(
      authorized('the.id.token'),
    );
    prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletAccount.findUnique.mockResolvedValue(null);
    prisma.walletLoginCode.create.mockResolvedValue({});

    const result = await service.claimOauth({
      state: 'st',
      codeVerifier: verifier,
      purpose: 'recovery',
    });

    expect(result.status).toBe('verify_email');
    expect(result).not.toHaveProperty('sessionToken');
    expect(prisma.walletLoginCode.create.mock.calls[0][0].data.idToken).toBe(
      'the.id.token',
    );
  });

  it('releases the carried ID token once the code is answered, and clears it from the row', async () => {
    const { service, prisma } = makeService();
    prisma.walletLoginCode.findUnique.mockResolvedValue({
      id: 'code_1',
      email: EMAIL,
      name: 'Ada',
      avatar: null,
      via: WalletAuthMethod.AUTHENTIK,
      codeHash: sha256Hex('048213'),
      attempts: 0,
      status: WalletLoginCodeStatus.PENDING,
      idToken: sealJson(
        { idToken: 'the.id.token' },
        SESSION_SECRET,
        ID_TOKEN_PURPOSE,
      ),
      expiresAt: new Date(NOW + 60_000),
    });
    prisma.walletLoginCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletAccount.findUnique.mockResolvedValue(null);

    const result = await service.verifyEmail({
      claimToken: 'tok',
      code: '048213',
    });

    expect(result).toMatchObject({ status: 'ready', idToken: 'the.id.token' });
    expect(
      prisma.walletLoginCode.updateMany.mock.calls[0][0].data.idToken,
    ).toBeNull();
  });

  /* A recovered account's address is its old master key, now at weight 0. */
  it('accepts a finish signed by the key that REPLACED the master', async () => {
    const newKey = Keypair.random();
    const { service, prisma } = makeService();
    prisma.walletAccount.findUnique.mockResolvedValue(null);
    prisma.walletAccount.upsert.mockResolvedValue({ id: 'acc_1' });
    global.fetch = jest.fn().mockImplementation((url: string) =>
      Promise.resolve(
        answer(
          url.includes('/accounts/')
            ? {
                signers: [
                  { key: ADDRESS, weight: 0, type: 'ed25519_public_key' },
                  {
                    key: newKey.publicKey(),
                    weight: 10,
                    type: 'ed25519_public_key',
                  },
                ],
                thresholds: { med_threshold: 10, high_threshold: 10 },
              }
            : { organizationId: 'org_1', keys: {} },
        ),
      ),
    );

    const result = await service.finish(session(), {
      stellarAddress: ADDRESS,
      signedAt: SIGNED_AT,
      signature: sign(newKey, finishMessage(EMAIL, ADDRESS, SIGNED_AT)),
    });

    expect(result.status).toBe('ready');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      `https://horizon.example.com/accounts/${ADDRESS}`,
    );
  });

  it('refuses a finish signed by a half-weight recovery signer', async () => {
    const server = Keypair.random();
    const { service } = makeService();
    global.fetch = jest.fn().mockResolvedValue(
      answer({
        signers: [
          { key: server.publicKey(), weight: 5, type: 'ed25519_public_key' },
        ],
        thresholds: { med_threshold: 10 },
      }),
    );
    await expect(
      service.finish(session(), {
        stellarAddress: ADDRESS,
        signedAt: SIGNED_AT,
        signature: sign(server, finishMessage(EMAIL, ADDRESS, SIGNED_AT)),
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.WalletSignatureInvalid });
  });

  describe('sponsorRecoverySetup', () => {
    const owner = Keypair.random();
    const sponsor = Keypair.random();
    const a = Keypair.random().publicKey();
    const b = Keypair.random().publicKey();
    const settings = {
      sponsor: {
        secret: sponsor.secret(),
        networkPassphrase: TESTNET,
        horizonUrl: 'https://horizon.example.com',
      },
    };
    const body = (signers: string[] = [a, b]) => ({
      stellarAddress: owner.publicKey(),
      signers,
      signedAt: SIGNED_AT,
      signature: sign(
        owner,
        recoverySetupMessage(owner.publicKey(), [a, b], SIGNED_AT),
      ),
    });
    const horizon = (signers: number) => {
      global.fetch = jest.fn().mockResolvedValue(
        answer({
          sequence: '100',
          signers: Array.from({ length: signers }, () => ({
            key: Keypair.random().publicKey(),
            weight: 1,
          })),
        }),
      );
    };

    it('builds the sponsored envelope, signed by the sponsor and not by the account', async () => {
      horizon(1);
      const { service } = makeService(settings);
      const built = await service.sponsorRecoverySetup(session(), body());
      const tx = TransactionBuilder.fromXDR(
        built.transaction,
        TESTNET,
      ) as Transaction;
      expect(built.sponsor).toBe(sponsor.publicKey());
      expect(tx.signatures).toHaveLength(1);
      expect(sponsor.verify(tx.hash(), tx.signatures[0].signature)).toBe(true);
      expect(tx.operations.map((o) => o.type)).toEqual([
        'beginSponsoringFutureReserves',
        'setOptions',
        'setOptions',
        'endSponsoringFutureReserves',
        'setOptions',
      ]);
    });

    it('sponsors a first setup only', async () => {
      horizon(3);
      const { service } = makeService(settings);
      await expect(
        service.sponsorRecoverySetup(session(), body()),
      ).rejects.toMatchObject({
        code: ApiErrorCode.WalletRecoverySetupRefused,
      });
    });

    it('refuses a signature over a different pair of signers', async () => {
      horizon(1);
      const { service } = makeService(settings);
      await expect(
        service.sponsorRecoverySetup(session(), body([b, a])),
      ).rejects.toMatchObject({
        code: ApiErrorCode.WalletSignatureInvalid,
      });
    });

    it('refuses a pair that names the account itself', async () => {
      horizon(1);
      const { service } = makeService(settings);
      await expect(
        service.sponsorRecoverySetup(session(), body([owner.publicKey(), b])),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletSignatureInvalid });
    });

    it('is off without a sponsor key', async () => {
      const { service } = makeService();
      await expect(
        service.sponsorRecoverySetup(session(), body()),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });
});
