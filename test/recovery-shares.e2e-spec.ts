import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';
import { issueIdentityToken, issueSep10Token } from '@/recovery/recovery-core';
import { RecoveryService } from '@/recovery/recovery.service';

/**
 * A backup's half of its recovery key, on a recovery server (e2e).
 *
 * What the wiring must get right, and a unit test of the service cannot see:
 *
 *  - the routes are PUBLIC — a wallet that lost everything has no API key, so the
 *    gateway guard must not stand in front of them; the SEP tokens are the
 *    credential, and a request with none is a SEP-shaped 401, not the API's;
 *  - only the account's own key files a half, and only the inbox it was filed
 *    under (or that key) takes it back — anyone else meets the same 404;
 *  - the body is validated before the service runs: a half that is not base64
 *    is a 400.
 *
 * The app is booted as recovery server "a", so the environment is set BEFORE
 * AppModule is imported (config is read at import) and restored afterwards —
 * a jest worker runs other suites in this same process.
 */
describe('Recovery backup shares (e2e)', () => {
  let app: INestApplication;
  let saved: NodeJS.ProcessEnv;
  const counters = new Map<string, number>();
  const ADDRESS = Keypair.random().publicKey();
  const SHARE = Buffer.alloc(32, 9).toString('base64');

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn((_parts: unknown, key: string, windowStart: Date) => {
      const bucket = `${key}|${windowStart.getTime()}`;
      const next = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, next);
      return Promise.resolve([{ count: next }]);
    }),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    recoveryBackupShare: {
      upsert: jest.fn().mockResolvedValue({
        address: ADDRESS,
        updatedAt: new Date('2026-10-04T12:00:00Z'),
      }),
      findUnique: jest.fn().mockResolvedValue({
        address: ADDRESS,
        share: SHARE,
        email: 'ada@example.com',
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  beforeAll(async () => {
    saved = { ...process.env };
    Object.assign(process.env, {
      RECOVERY_ROLE: 'a',
      RECOVERY_PUBLIC_BASE_URL: 'https://recovery-a.example.com/cosmos-api',
      RECOVERY_HOME_DOMAIN: 'example.com',
      RECOVERY_SIGNER_MASTER: Keypair.random().secret(),
      RECOVERY_SEP10_SIGNING_SECRET: Keypair.random().secret(),
      RECOVERY_JWT_SECRET: 'e2e-recovery-jwt-secret-e2e-recovery-jwt',
      RECOVERY_OIDC_ISSUER: 'https://auth.example.com/application/o/wallet/',
      RECOVERY_OIDC_AUDIENCES: 'wallet-client',
      RECOVERY_SWEEP_ENABLED: 'false',
      // A recovery server does not serve the sign-in, nor hold the sponsor.
      WALLET_AUTH_SESSION_SECRET: '',
      WALLET_RECOVERY_SPONSOR_SECRET: '',
    });
    const { AppModule } = await import('@/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env = saved;
  });

  beforeEach(() => counters.clear());

  const http = () => app.getHttpServer();
  const rules = () => app.get(RecoveryService).rules();
  const keyOf = (address: string) =>
    `Bearer ${issueSep10Token(rules(), address)}`;
  const inbox = (email: string) =>
    `Bearer ${issueIdentityToken(rules(), email)}`;
  const path = `/v1/sep30/shares/${ADDRESS}`;

  it('needs no API key, and answers a missing token with a SEP 401', async () => {
    const res = await request(http()).get(path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it("files a half under the account's own key", async () => {
    const res = await request(http())
      .put(path)
      .set('authorization', keyOf(ADDRESS))
      .send({ share: SHARE, email: 'ada@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: ADDRESS,
      updated_at: '2026-10-04T12:00:00.000Z',
    });
  });

  it('refuses an inbox filing one, and a half that is not base64', async () => {
    const asInbox = await request(http())
      .put(path)
      .set('authorization', inbox('ada@example.com'))
      .send({ share: SHARE, email: 'ada@example.com' });
    expect(asInbox.status).toBe(403);

    const junk = await request(http())
      .put(path)
      .set('authorization', keyOf(ADDRESS))
      .send({ share: 'not base64!', email: 'ada@example.com' });
    expect(junk.status).toBe(400);
  });

  it('hands the half to the proven inbox and to nobody else', async () => {
    const mine = await request(http())
      .get(path)
      .set('authorization', inbox('ada@example.com'));
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ address: ADDRESS, share: SHARE });

    const theirs = await request(http())
      .get(path)
      .set('authorization', inbox('eve@example.com'));
    expect(theirs.status).toBe(404);
  });
});
