import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  WalletAuthHandshakeStatus,
  WalletAuthMethod,
  WalletAuthProvider,
  WalletLoginCodeStatus,
} from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { OidcService } from '@/common/oidc/oidc.service';
import { WalletAuthService } from '@/wallet-auth/wallet-auth.service';
import { LOGIN_CODE_MAX_ATTEMPTS } from '@/wallet-auth/wallet-auth.constants';
import {
  backupMessage,
  finishMessage,
  issueSessionToken,
  sha256Hex,
} from '@/wallet-auth/wallet-auth-core';

/* The same fixed vectors the core spec uses — signed once with the SDK. */
const ADDRESS = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const OTHER_ADDRESS =
  'GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL';
const SIGNED_AT = '2026-01-02T03:04:05Z';
const NOW = Date.parse(SIGNED_AT);
const FINISH_SIGNATURE =
  'msWcPRf8GVEgAnlPd44NIhax6lhkH4Yi3GkGQdNLIh87brdw3uA0Ar8CRj/TYO9sJ6pWsNhxhQ3+1Qd+kCKNDA==';
const BACKUP_SIGNATURE =
  'nvwZGuTCgDCT8Aj7iShTY4Ppfj3YupP3pB0Bg7wP8+x5jyc4Wv5yxteN/mhxdbZMnGNE9FtpWTt5sA5NbdMvDA==';
const EMAIL = 'ada@example.com';
const SESSION_SECRET = 'a-server-secret-long-enough-to-be-real';

const BOX = JSON.stringify({
  v: 2,
  salt: Buffer.alloc(16, 1).toString('base64'),
  iv: Buffer.alloc(12, 2).toString('base64'),
  data: Buffer.alloc(64, 3).toString('base64'),
  iter: 600_000,
});

const SETTINGS = {
  publicBaseUrl: 'https://api.example.com',
  sessionSecret: SESSION_SECRET,
  consoleUrl: 'https://console.example.com',
  consoleSecret: 'console-secret',
  google: { clientId: 'gid', clientSecret: 'gsecret' },
  github: { clientId: '', clientSecret: '' },
  oidc: { issuer: '', clientId: '', clientSecret: '' },
  signersHorizonUrl: 'https://horizon.example.com',
  sponsor: {
    secret: '',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon.example.com',
  },
  timeoutMs: 1000,
  sweep: { enabled: true, intervalMs: 60_000 },
};

type Mocked = Record<string, jest.Mock>;

function makePrisma() {
  return {
    walletAuthHandshake: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    } as Mocked,
    walletLoginCode: {
      create: jest.fn(),
      // Nothing sent today unless a test says otherwise.
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    } as Mocked,
    walletAccount: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    } as Mocked,
    walletBackup: {
      findFirst: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    } as Mocked,
  };
}

function makeService(settings: Partial<typeof SETTINGS> = {}) {
  const prisma = makePrisma();
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

/** The console hop always answers, unless a test says otherwise. */
function stubConsole(body: unknown = { organizationId: 'org_1', keys: {} }) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
  global.fetch = fetchMock;
  return fetchMock;
}

describe('WalletAuthService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    stubConsole();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('providers', () => {
    it('reports only the providers this deployment has credentials for', () => {
      const { service } = makeService();
      expect(service.providers()).toEqual({
        providers: ['google'],
        email: true,
      });
    });

    it('reports no email door when nothing can deliver the code', () => {
      const { service } = makeService({ consoleUrl: '' });
      expect(service.providers().email).toBe(false);
    });
  });

  describe('startOauth', () => {
    it('refuses a provider this deployment has no credentials for', async () => {
      const { service } = makeService();
      await expect(
        service.startOauth({
          provider: 'github',
          codeChallenge: 'x'.repeat(43),
          codeChallengeMethod: 'S256',
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletProviderUnavailable });
    });

    it('refuses an unknown provider outright', async () => {
      const { service } = makeService();
      await expect(
        service.startOauth({
          provider: 'pollar',
          codeChallenge: 'x'.repeat(43),
          codeChallengeMethod: 'S256',
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it('stores the challenge and builds a URL carrying the state', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.create.mockResolvedValue({});

      const started = await service.startOauth({
        provider: 'google',
        codeChallenge: 'c'.repeat(43),
        codeChallengeMethod: 'S256',
      });

      const stored = prisma.walletAuthHandshake.create.mock.calls[0][0].data;
      expect(stored.codeChallenge).toBe('c'.repeat(43));
      expect(stored.provider).toBe(WalletAuthProvider.GOOGLE);
      const url = new URL(started.authorizationUrl);
      expect(url.searchParams.get('state')).toBe(started.state);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/v1/wallet/auth/oauth/callback/google',
      );
    });
  });

  describe('pollStatus', () => {
    it('never returns the identity, even once it is known', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue({
        status: WalletAuthHandshakeStatus.AUTHORIZED,
        failure: null,
        expiresAt: new Date(NOW + 60_000),
      });
      const status = await service.pollStatus('st');
      expect(status).toEqual({ status: 'authorized' });
    });

    it('reports a handshake past its deadline as expired', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue({
        status: WalletAuthHandshakeStatus.PENDING,
        failure: null,
        expiresAt: new Date(NOW - 1),
      });
      expect(await service.pollStatus('st')).toEqual({ status: 'expired' });
    });

    it('reports an unknown state as expired, not as missing', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue(null);
      expect(await service.pollStatus('st')).toEqual({ status: 'expired' });
    });
  });

  describe('claimOauth', () => {
    const verifier = 'a-verifier-the-device-kept-to-itself-0000000';
    const challenge = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url');

    function authorizedHandshake() {
      return {
        state: 'st',
        provider: WalletAuthProvider.GOOGLE,
        codeChallenge: challenge,
        status: WalletAuthHandshakeStatus.AUTHORIZED,
        email: EMAIL,
        name: 'Ada',
        avatar: null,
        subject: '123',
        expiresAt: new Date(NOW + 60_000),
      };
    }

    it('refuses a verifier that does not match the challenge', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue(
        authorizedHandshake(),
      );
      await expect(
        service.claimOauth({
          state: 'st',
          codeVerifier: 'wrong-verifier-entirely',
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletVerifierInvalid });
      expect(prisma.walletAuthHandshake.updateMany).not.toHaveBeenCalled();
    });

    it('burns the handshake before handing anything back', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue(
        authorizedHandshake(),
      );
      prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
      prisma.walletAccount.findUnique.mockResolvedValue(null);

      await service.claimOauth({ state: 'st', codeVerifier: verifier });

      expect(prisma.walletAuthHandshake.updateMany).toHaveBeenCalledWith({
        where: { state: 'st', status: WalletAuthHandshakeStatus.AUTHORIZED },
        // The ID token leaves the row in the same write that burns it.
        data: { status: WalletAuthHandshakeStatus.REDEEMED, idToken: null },
      });
    });

    it('loses a race rather than issuing two tokens for one handshake', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue(
        authorizedHandshake(),
      );
      // The other request got there first.
      prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 0 });

      expect(
        await service.claimOauth({ state: 'st', codeVerifier: verifier }),
      ).toEqual({
        status: 'expired',
      });
    });

    it('gives a NEW email a session token', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue(
        authorizedHandshake(),
      );
      prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
      prisma.walletAccount.findUnique.mockResolvedValue(null);

      const result = await service.claimOauth({
        state: 'st',
        codeVerifier: verifier,
      });

      expect(result.status).toBe('ready');
      // A marker the wallet branches its onboarding on, never an id.
      expect(result).toMatchObject({ account: 'new' });
      expect(prisma.walletLoginCode.create).not.toHaveBeenCalled();
    });

    /* The rule the whole design turns on: a provider proves who consented, not
       who opened the sign-in, and an existing account is where the backup worth
       stealing is. */
    it('sends an EXISTING account to its inbox instead of handing over a token', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue(
        authorizedHandshake(),
      );
      prisma.walletAuthHandshake.updateMany.mockResolvedValue({ count: 1 });
      prisma.walletAccount.findUnique.mockResolvedValue({
        id: 'acc_1',
        stellarAddress: ADDRESS,
        backup: { stellarAddress: ADDRESS, box: BOX, updatedAt: new Date(NOW) },
      });
      prisma.walletLoginCode.create.mockResolvedValue({});

      const result = await service.claimOauth({
        state: 'st',
        codeVerifier: verifier,
      });

      expect(result.status).toBe('verify_email');
      expect(result).not.toHaveProperty('sessionToken');
      expect(result).not.toHaveProperty('backup');
      expect(prisma.walletLoginCode.create).toHaveBeenCalled();
    });

    it('reports a pending handshake as pending, not as an error', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue({
        ...authorizedHandshake(),
        status: WalletAuthHandshakeStatus.PENDING,
      });
      expect(
        await service.claimOauth({ state: 'st', codeVerifier: verifier }),
      ).toEqual({
        status: 'pending',
      });
    });

    it('collapses redeemed into expired, so a state cannot be probed', async () => {
      const { service, prisma } = makeService();
      prisma.walletAuthHandshake.findUnique.mockResolvedValue({
        ...authorizedHandshake(),
        status: WalletAuthHandshakeStatus.REDEEMED,
      });
      expect(
        await service.claimOauth({ state: 'st', codeVerifier: verifier }),
      ).toEqual({
        status: 'expired',
      });
    });
  });

  describe('startEmail', () => {
    it('enforces the cooldown on the ROW, so rotating an address buys nothing', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findFirst.mockResolvedValue({
        sentAt: new Date(NOW - 1_000),
      });
      await expect(service.startEmail({ email: EMAIL })).rejects.toMatchObject({
        code: ApiErrorCode.WalletLoginCodeCooldown,
      });
      expect(prisma.walletLoginCode.create).not.toHaveBeenCalled();
    });

    it('stores only hashes, never the code or the claim token', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findFirst.mockResolvedValue(null);
      prisma.walletAccount.findUnique.mockResolvedValue(null);
      prisma.walletLoginCode.create.mockResolvedValue({});

      const sent = await service.startEmail({ email: '  Ada@Example.com ' });

      const stored = prisma.walletLoginCode.create.mock.calls[0][0].data;
      expect(stored.email).toBe(EMAIL);
      expect(stored.claimHash).toBe(sha256Hex(sent.claimToken));
      expect(stored.codeHash).toHaveLength(64);
      expect(JSON.stringify(stored)).not.toContain(sent.claimToken);
    });

    it('hands the code to the console rather than keeping a mailer', async () => {
      const fetchMock = stubConsole();
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findFirst.mockResolvedValue(null);
      prisma.walletAccount.findUnique.mockResolvedValue(null);
      prisma.walletLoginCode.create.mockResolvedValue({});

      await service.startEmail({ email: EMAIL });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://console.example.com/wallet/console/login-code');
      expect(JSON.parse(init.body).code).toMatch(/^\d{6}$/);
      expect(init.headers['x-cosmos-internal']).toBe('1');
    });

    it('refuses when no console is configured rather than minting a code nobody sends', async () => {
      const { service, prisma } = makeService({ consoleUrl: '' });
      prisma.walletLoginCode.findFirst.mockResolvedValue(null);
      prisma.walletAccount.findUnique.mockResolvedValue(null);
      prisma.walletLoginCode.create.mockResolvedValue({});

      await expect(service.startEmail({ email: EMAIL })).rejects.toMatchObject({
        code: ApiErrorCode.Misconfigured,
      });
    });
  });

  describe('startEmail daily cap', () => {
    /* A per-minute cooldown alone is thousands of blind guesses a day at one inbox. */
    it('refuses past the daily total, even with the cooldown clear', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findFirst.mockResolvedValue(null);
      prisma.walletLoginCode.count.mockResolvedValue(10);
      await expect(service.startEmail({ email: EMAIL })).rejects.toMatchObject({
        code: ApiErrorCode.WalletLoginCodeCooldown,
      });
      expect(prisma.walletLoginCode.create).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    function pendingCode(attempts = 0) {
      return {
        id: 'code_1',
        email: EMAIL,
        name: 'Ada',
        avatar: null,
        via: WalletAuthMethod.EMAIL,
        codeHash: sha256Hex('048213'),
        attempts,
        status: WalletLoginCodeStatus.PENDING,
        expiresAt: new Date(NOW + 60_000),
      };
    }

    it('counts a wrong code and reports what is left', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findUnique.mockResolvedValue(pendingCode(0));
      prisma.walletLoginCode.update.mockResolvedValue({});

      const result = await service.verifyEmail({
        claimToken: 'tok',
        code: '000000',
      });

      expect(result).toEqual({
        status: 'invalid',
        attemptsLeft: LOGIN_CODE_MAX_ATTEMPTS - 1,
      });
      expect(prisma.walletLoginCode.update.mock.calls[0][0].data.attempts).toBe(
        1,
      );
    });

    it('burns the row at the attempt cap', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findUnique.mockResolvedValue(
        pendingCode(LOGIN_CODE_MAX_ATTEMPTS - 1),
      );
      prisma.walletLoginCode.update.mockResolvedValue({});

      expect(
        await service.verifyEmail({ claimToken: 'tok', code: '000000' }),
      ).toEqual({ status: 'locked' });
      expect(prisma.walletLoginCode.update.mock.calls[0][0].data.status).toBe(
        WalletLoginCodeStatus.LOCKED,
      );
    });

    it('hands back the backup once the right code arrives', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findUnique.mockResolvedValue(pendingCode(0));
      prisma.walletLoginCode.updateMany.mockResolvedValue({ count: 1 });
      prisma.walletAccount.findUnique.mockResolvedValue({
        id: 'acc_1',
        stellarAddress: ADDRESS,
        backup: { stellarAddress: ADDRESS, box: BOX, updatedAt: new Date(NOW) },
      });

      const result = await service.verifyEmail({
        claimToken: 'tok',
        code: '048213',
      });

      expect(result.status).toBe('ready');
      expect(result).toMatchObject({
        backup: { stellarAddress: ADDRESS, box: BOX },
      });
    });

    it('reports an unknown claim token as expired', async () => {
      const { service, prisma } = makeService();
      prisma.walletLoginCode.findUnique.mockResolvedValue(null);
      expect(
        await service.verifyEmail({ claimToken: 'tok', code: '048213' }),
      ).toEqual({ status: 'expired' });
    });
  });

  describe('finish', () => {
    const token = () =>
      issueSessionToken(
        {
          email: EMAIL,
          name: 'Ada',
          avatar: null,
          method: WalletAuthMethod.GOOGLE,
        },
        SESSION_SECRET,
        NOW,
      );

    const body = () => ({
      stellarAddress: ADDRESS,
      signedAt: SIGNED_AT,
      signature: FINISH_SIGNATURE,
    });

    it('refuses a token this service did not seal', async () => {
      const { service } = makeService();
      const forged = issueSessionToken(
        {
          email: EMAIL,
          name: null,
          avatar: null,
          method: WalletAuthMethod.GOOGLE,
        },
        'some-other-servers-secret',
        NOW,
      );
      await expect(service.finish(forged, body())).rejects.toMatchObject({
        code: ApiErrorCode.WalletSessionInvalid,
      });
    });

    it('refuses a signature made by another key', async () => {
      const { service } = makeService();
      await expect(
        service.finish(token(), { ...body(), stellarAddress: OTHER_ADDRESS }),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletSignatureInvalid });
    });

    it('refuses a timestamp outside the window', async () => {
      // Twenty minutes: past the ten-minute clock skew, but still inside the
      // token's own thirty-minute life — so this fails on the signature rather
      // than on the session, which is the check under test.
      jest.setSystemTime(NOW + 20 * 60 * 1000);
      const { service } = makeService();
      await expect(service.finish(token(), body())).rejects.toMatchObject({
        code: ApiErrorCode.WalletSignatureInvalid,
      });
    });

    it('refuses a box sealed below the PBKDF2 floor', async () => {
      const { service } = makeService();
      const weak = JSON.stringify({ ...JSON.parse(BOX), iter: 1000 });
      await expect(
        service.finish(token(), { ...body(), backup: weak }),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletBackupInvalid });
    });

    /* The box being discarded may be the only copy of a funded wallet, so it is
       never replaced by implication. */
    it('refuses to overwrite a backup held for another address', async () => {
      const { service, prisma } = makeService();
      prisma.walletAccount.findUnique.mockResolvedValue({
        id: 'acc_1',
        stellarAddress: OTHER_ADDRESS,
        backup: {
          stellarAddress: OTHER_ADDRESS,
          box: BOX,
          updatedAt: new Date(NOW),
        },
      });

      const result = await service.finish(token(), { ...body(), backup: BOX });

      expect(result).toEqual({
        status: 'backup_conflict',
        stellarAddress: OTHER_ADDRESS,
      });
      expect(prisma.walletAccount.upsert).not.toHaveBeenCalled();
    });

    it('replaces it when the person explicitly asked', async () => {
      const { service, prisma } = makeService();
      prisma.walletAccount.findUnique.mockResolvedValue({
        id: 'acc_1',
        stellarAddress: OTHER_ADDRESS,
        backup: {
          stellarAddress: OTHER_ADDRESS,
          box: BOX,
          updatedAt: new Date(NOW),
        },
      });
      prisma.walletAccount.upsert.mockResolvedValue({ id: 'acc_1' });
      prisma.walletBackup.upsert.mockResolvedValue({});

      const result = await service.finish(token(), {
        ...body(),
        backup: BOX,
        replaceBackup: true,
      });

      expect(result.status).toBe('ready');
      expect(result).toMatchObject({ account: 'linked' });
      expect(prisma.walletBackup.upsert).toHaveBeenCalled();
    });

    it('creates the account and asks the console for its keys', async () => {
      const fetchMock = stubConsole({
        organizationId: 'org_1',
        keys: { dev: 'k_dev', prod: 'k_prod' },
      });
      const { service, prisma } = makeService();
      prisma.walletAccount.findUnique.mockResolvedValue(null);
      prisma.walletAccount.upsert.mockResolvedValue({ id: 'acc_1' });

      const result = await service.finish(token(), body());

      expect(result).toEqual({
        status: 'ready',
        // `finish` speaks its own two-word vocabulary, and the wallet types it.
        account: 'created',
        organizationId: 'org_1',
        keys: { dev: 'k_dev', prod: 'k_prod' },
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://console.example.com/wallet/console/provision',
      );
    });
  });

  describe('replaceBackupBox', () => {
    const body = () => ({
      stellarAddress: ADDRESS,
      box: BOX,
      signedAt: SIGNED_AT,
      signature: BACKUP_SIGNATURE,
    });

    it('accepts a signature by the address that owns the box', async () => {
      const { service, prisma } = makeService();
      prisma.walletBackup.findFirst.mockResolvedValue({ id: 'b_1' });
      prisma.walletBackup.update.mockResolvedValue({
        stellarAddress: ADDRESS,
        updatedAt: new Date(NOW),
      });

      expect(await service.replaceBackupBox(body())).toMatchObject({
        status: 'ok',
        stellarAddress: ADDRESS,
      });
    });

    it('refuses a signature made for another address', async () => {
      const { service } = makeService();
      await expect(
        service.replaceBackupBox({ ...body(), stellarAddress: OTHER_ADDRESS }),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletSignatureInvalid });
    });

    it('refuses a box that is not one the wallet could have written', async () => {
      const { service } = makeService();
      await expect(
        service.replaceBackupBox({ ...body(), box: 'not a box' }),
      ).rejects.toMatchObject({ code: ApiErrorCode.WalletBackupInvalid });
    });

    it('looks the backup up by the address that SIGNED, never by one sent alongside', async () => {
      const { service, prisma } = makeService();
      prisma.walletBackup.findFirst.mockResolvedValue({ id: 'b_1' });
      prisma.walletBackup.update.mockResolvedValue({
        stellarAddress: ADDRESS,
        updatedAt: new Date(NOW),
      });

      await service.replaceBackupBox(body());

      expect(prisma.walletBackup.findFirst).toHaveBeenCalledWith({
        where: { stellarAddress: ADDRESS },
        select: { id: true },
      });
    });

    it('covers the box hash, so a signature cannot be replayed for another box', () => {
      const other = JSON.stringify({ ...JSON.parse(BOX), iter: 700_000 });
      expect(backupMessage(ADDRESS, BOX, SIGNED_AT)).not.toBe(
        backupMessage(ADDRESS, other, SIGNED_AT),
      );
    });

    it('is a different challenge from the sign-in one', () => {
      expect(backupMessage(ADDRESS, BOX, SIGNED_AT)).not.toBe(
        finishMessage(EMAIL, ADDRESS, SIGNED_AT),
      );
    });
  });
});
