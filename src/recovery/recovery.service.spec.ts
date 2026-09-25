import { ConfigService } from '@nestjs/config';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { OidcService } from '@/common/oidc/oidc.service';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { issueIdentityToken, issueSep10Token } from '@/recovery/recovery-core';
import { RecoveryService, SepError } from '@/recovery/recovery.service';

const SETTINGS = {
  role: 'a' as const,
  publicBaseUrl: 'https://recovery-a.example.com/cosmos-api',
  homeDomain: 'example.com',
  networkPassphrase: Networks.TESTNET,
  horizonUrl: 'https://horizon.example.com',
  signerMaster: Keypair.random().secret(),
  sep10SigningSecret: Keypair.random().secret(),
  jwtSecret: 'a-recovery-jwt-secret-long-enough-000000',
  oidc: {
    issuer: 'https://auth.example.com/application/o/wallet/',
    audiences: ['wallet-client'],
  },
  emailDelivery: {
    url: 'https://console.example.com/api/wallet/console/recovery-code',
    secret: 'x'.repeat(40),
  },
  timeoutMs: 1000,
  sweep: { enabled: true, intervalMs: 60_000 },
};

function unique() {
  return Object.assign(new Error('unique'), { code: 'P2002' });
}

function makeService(settings: Partial<typeof SETTINGS> = {}) {
  const prisma = {
    recoveryUsedIdToken: { create: jest.fn() },
    recoveryEmailCode: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    recoveryAuthMethod: { count: jest.fn() },
    recoveryAccount: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const config = {
    get: jest.fn().mockReturnValue({ ...SETTINGS, ...settings }),
  } as unknown as ConfigService<AppConfig, true>;
  const oidc = { verify: jest.fn(), discover: jest.fn() };
  const service = new RecoveryService(
    prisma as unknown as PrismaService,
    config,
    oidc as unknown as OidcService,
  );
  return { service, prisma, oidc };
}

const claims = {
  email: 'ada@example.com',
  sub: 's',
  iss: SETTINGS.oidc.issuer,
  name: null,
  picture: null,
  iat: 0,
  exp: 2_000_000_000,
  authTime: 0,
};

describe('RecoveryService', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });

  it('answers 404 on a deployment that is not a recovery server', () => {
    const { service } = makeService({ role: null as never });
    expect(() => service.stellarToml()).toThrow(SepError);
  });

  describe('exchangeIdToken', () => {
    it('verifies against the configured issuer and audiences, with a login-age bound', async () => {
      const { service, prisma, oidc } = makeService();
      oidc.verify.mockResolvedValue({ ok: true, claims });
      prisma.recoveryUsedIdToken.create.mockResolvedValue({});

      const out = await service.exchangeIdToken('id.token.here');

      expect(oidc.verify.mock.calls[0][1]).toMatchObject({
        issuer: SETTINGS.oidc.issuer,
        audiences: ['wallet-client'],
        maxAgeSeconds: expect.any(Number),
      });
      expect(out.token).toBeTruthy();
    });

    /* One login, presented to each of the two servers once. */
    it('refuses an ID token it has already exchanged', async () => {
      const { service, prisma, oidc } = makeService();
      oidc.verify.mockResolvedValue({ ok: true, claims });
      prisma.recoveryUsedIdToken.create.mockRejectedValue(unique());
      await expect(
        service.exchangeIdToken('id.token.here'),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('issues nothing for a token that does not verify', async () => {
      const { service, prisma, oidc } = makeService();
      oidc.verify.mockResolvedValue({ ok: false, error: 'bad_signature' });
      await expect(service.exchangeIdToken('forged')).rejects.toMatchObject({
        status: 401,
      });
      expect(prisma.recoveryUsedIdToken.create).not.toHaveBeenCalled();
    });

    it('is a 404 on a server that takes no ID tokens', async () => {
      const { service } = makeService({ oidc: { issuer: '', audiences: [] } });
      await expect(service.exchangeIdToken('x')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('startEmail', () => {
    it('sends a code only to an inbox that recovers something here', async () => {
      const { service, prisma } = makeService();
      prisma.recoveryEmailCode.findFirst.mockResolvedValue(null);
      prisma.recoveryEmailCode.create.mockResolvedValue({});
      prisma.recoveryAuthMethod.count.mockResolvedValue(0);

      const unregistered = await service.startEmail('stranger@example.com');
      expect(global.fetch).not.toHaveBeenCalled();

      prisma.recoveryAuthMethod.count.mockResolvedValue(1);
      const registered = await service.startEmail('ada@example.com');
      await new Promise((r) => setImmediate(r));
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // The same answer either way: the response does not say which inbox is registered.
      expect(Object.keys(unregistered)).toEqual(Object.keys(registered));
    });
  });

  describe('startEmail daily cap', () => {
    it('refuses past the daily total, registered inbox or not', async () => {
      const { service, prisma } = makeService();
      prisma.recoveryEmailCode.findFirst.mockResolvedValue(null);
      prisma.recoveryEmailCode.count.mockResolvedValue(10);
      await expect(service.startEmail('ada@example.com')).rejects.toMatchObject(
        {
          status: 429,
        },
      );
      expect(prisma.recoveryEmailCode.create).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('issues an identity token for the right code, once', async () => {
      const { service, prisma } = makeService();
      const { sha256Hex } = await import('@/wallet-auth/wallet-auth-core');
      prisma.recoveryEmailCode.findUnique.mockResolvedValue({
        id: 'c1',
        role: 'a',
        email: 'ada@example.com',
        codeHash: sha256Hex('123456'),
        attempts: 0,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.recoveryEmailCode.updateMany.mockResolvedValue({ count: 1 });
      expect(await service.verifyEmail('claim', '123456')).toMatchObject({
        status: 'ready',
      });

      prisma.recoveryEmailCode.updateMany.mockResolvedValue({ count: 0 });
      expect(await service.verifyEmail('claim', '123456')).toEqual({
        status: 'expired',
      });
    });

    it("refuses the sibling server's row", async () => {
      const { service, prisma } = makeService();
      prisma.recoveryEmailCode.findUnique.mockResolvedValue({
        id: 'c1',
        role: 'b',
      });
      expect(await service.verifyEmail('claim', '123456')).toEqual({
        status: 'expired',
      });
    });
  });

  describe('account routes', () => {
    const owner = Keypair.random().publicKey();
    const rules = () => makeService().service.rules();

    it('lets only the key holder register', async () => {
      const { service } = makeService();
      const identity = `Bearer ${issueIdentityToken(rules(), 'ada@example.com')}`;
      await expect(
        service.register(identity, owner, [
          {
            role: 'owner',
            auth_methods: [{ type: 'email', value: 'ada@example.com' }],
          },
        ]),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('answers 409 on a second registration', async () => {
      const { service, prisma } = makeService();
      prisma.recoveryAccount.findUnique.mockResolvedValue({
        id: 'r1',
        address: owner,
        createdAt: new Date(),
        methods: [],
      });
      const token = `Bearer ${issueSep10Token(rules(), owner)}`;
      await expect(
        service.register(token, owner, [
          {
            role: 'owner',
            auth_methods: [{ type: 'email', value: 'ada@example.com' }],
          },
        ]),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('answers a stranger inbox with the same 404 as an absent account', async () => {
      const { service, prisma } = makeService();
      prisma.recoveryAccount.findUnique.mockResolvedValue({
        id: 'r1',
        address: owner,
        createdAt: new Date(),
        methods: [
          { identityRole: 'owner', type: 'email', value: 'ada@example.com' },
        ],
      });
      const eve = `Bearer ${issueIdentityToken(rules(), 'eve@example.com')}`;
      await expect(service.get(eve, owner)).rejects.toMatchObject({
        status: 404,
      });
      prisma.recoveryAccount.findUnique.mockResolvedValue(null);
      await expect(service.get(eve, owner)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('refuses a missing or foreign token with 401', async () => {
      const { service } = makeService();
      await expect(service.get(undefined, owner)).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        service.get('Bearer not-a-token', owner),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
