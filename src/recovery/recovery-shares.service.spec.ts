import { ConfigService } from '@nestjs/config';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { OidcService } from '@/common/oidc/oidc.service';
import { AppConfig } from '@/config/configuration';
import { MailerService } from '@/mailer/mailer.service';
import { PrismaService } from '@/prisma/prisma.service';
import {
  issueIdentityToken,
  issueSep10Token,
  type RecoveryRules,
} from '@/recovery/recovery-core';
import { RecoveryService } from '@/recovery/recovery.service';
import { RecoverySharesService } from '@/recovery/recovery-shares.service';

const SETTINGS = {
  role: 'a' as 'a' | 'b',
  publicBaseUrl: 'https://recovery-a.example.com/cosmos-api',
  homeDomain: 'example.com',
  networkPassphrase: Networks.TESTNET,
  horizonUrl: 'https://horizon.example.com',
  signerMaster: Keypair.random().secret(),
  sep10SigningSecret: Keypair.random().secret(),
  jwtSecret: 'a-recovery-jwt-secret-long-enough-000000',
  oidc: { issuer: '', audiences: [] },
  emailCodes: true,
  timeoutMs: 1000,
  sweep: { enabled: true, intervalMs: 60_000 },
};

const ADDRESS = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const SHARE = Buffer.alloc(32, 7).toString('base64');
const ROW = { address: ADDRESS, share: SHARE, email: 'ada@example.com' };

function makeService(settings: Partial<typeof SETTINGS> = {}) {
  const prisma = {
    recoveryBackupShare: {
      upsert: jest.fn().mockResolvedValue({
        address: ADDRESS,
        updatedAt: new Date('2026-10-04T12:00:00Z'),
      }),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const config = {
    get: jest.fn().mockReturnValue({ ...SETTINGS, ...settings }),
  } as unknown as ConfigService<AppConfig, true>;
  const recovery = new RecoveryService(
    prisma as unknown as PrismaService,
    config,
    {} as OidcService,
    { configured: true } as unknown as MailerService,
  );
  const service = new RecoverySharesService(
    prisma as unknown as PrismaService,
    recovery,
  );
  return {
    service,
    prisma,
    // A getter: a deployment with no role has no rules, and saying so is a test.
    get rules() {
      return recovery.rules();
    },
  };
}

const bearer = (token: string) => `Bearer ${token}`;
const keyOf = (rules: RecoveryRules, address: string) =>
  bearer(issueSep10Token(rules, address));
const inbox = (rules: RecoveryRules, email: string) =>
  bearer(issueIdentityToken(rules, email));

describe('RecoverySharesService', () => {
  describe('put', () => {
    it("files the half under the account's own SEP-10 token, email normalized", async () => {
      const { service, prisma, rules } = makeService();
      await expect(
        service.put(keyOf(rules, ADDRESS), ADDRESS, SHARE, ' Ada@Example.COM '),
      ).resolves.toEqual({
        address: ADDRESS,
        updated_at: '2026-10-04T12:00:00.000Z',
      });
      expect(prisma.recoveryBackupShare.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { role_address: { role: 'a', address: ADDRESS } },
          create: {
            role: 'a',
            address: ADDRESS,
            share: SHARE,
            email: 'ada@example.com',
          },
        }),
      );
    });

    it('refuses an identity, or another account, filing a half — a way in, not back', async () => {
      const { service, prisma, rules } = makeService();
      await expect(
        service.put(
          inbox(rules, 'ada@example.com'),
          ADDRESS,
          SHARE,
          'ada@example.com',
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.put(keyOf(rules, OTHER), ADDRESS, SHARE, 'ada@example.com'),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.recoveryBackupShare.upsert).not.toHaveBeenCalled();
    });

    it('refuses a half that is not 32 bytes', async () => {
      const { service, rules } = makeService();
      await expect(
        service.put(
          keyOf(rules, ADDRESS),
          ADDRESS,
          Buffer.alloc(16).toString('base64'),
          'ada@example.com',
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('is a 401 without a token, and a 404 on a server that is not a recovery server', async () => {
      const { service } = makeService();
      await expect(
        service.put(undefined, ADDRESS, SHARE, 'ada@example.com'),
      ).rejects.toMatchObject({ status: 401 });
      const off = makeService({ role: undefined as never });
      await expect(
        off.service.put('Bearer x', ADDRESS, SHARE, 'ada@example.com'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('get', () => {
    it('hands the half to the proven inbox it was filed under', async () => {
      const { service, prisma, rules } = makeService();
      prisma.recoveryBackupShare.findUnique.mockResolvedValue(ROW);
      await expect(
        service.get(inbox(rules, 'ADA@example.com'), ADDRESS),
      ).resolves.toEqual({ address: ADDRESS, share: SHARE });
    });

    it('hands it to the key holder too', async () => {
      const { service, prisma, rules } = makeService();
      prisma.recoveryBackupShare.findUnique.mockResolvedValue(ROW);
      await expect(
        service.get(keyOf(rules, ADDRESS), ADDRESS),
      ).resolves.toEqual({ address: ADDRESS, share: SHARE });
    });

    it('answers another inbox, another key and no half with the same 404', async () => {
      const { service, prisma, rules } = makeService();
      prisma.recoveryBackupShare.findUnique.mockResolvedValue(ROW);
      await expect(
        service.get(inbox(rules, 'eve@example.com'), ADDRESS),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.get(keyOf(rules, OTHER), ADDRESS),
      ).rejects.toMatchObject({ status: 404 });
      prisma.recoveryBackupShare.findUnique.mockResolvedValue(null);
      await expect(
        service.get(inbox(rules, 'ada@example.com'), ADDRESS),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("refuses the sibling server's identity token", async () => {
      const { service, prisma } = makeService();
      prisma.recoveryBackupShare.findUnique.mockResolvedValue(ROW);
      const sibling = makeService({ role: 'b' });
      await expect(
        service.get(inbox(sibling.rules, 'ada@example.com'), ADDRESS),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('remove', () => {
    it('forgets the half for the key holder only', async () => {
      const { service, prisma, rules } = makeService();
      prisma.recoveryBackupShare.deleteMany.mockResolvedValue({ count: 1 });
      await expect(
        service.remove(keyOf(rules, ADDRESS), ADDRESS),
      ).resolves.toEqual({
        address: ADDRESS,
      });
      await expect(
        service.remove(inbox(rules, 'ada@example.com'), ADDRESS),
      ).rejects.toMatchObject({ status: 403 });
      prisma.recoveryBackupShare.deleteMany.mockResolvedValue({ count: 0 });
      await expect(
        service.remove(keyOf(rules, ADDRESS), ADDRESS),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
