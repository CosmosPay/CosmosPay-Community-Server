import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Alias recovery (e2e).
 *
 * Starting a recovery returns the token that stands for control of the owner's
 * mailbox, for the platform console to email. So the route is closed to every
 * API-key caller — an `admin` key included, since it clears every scope check —
 * and the refusal happens BEFORE the alias is looked up, so it reveals nothing
 * about whether the handle or the mailbox exist.
 */
describe('Alias recovery (e2e)', () => {
  let app: INestApplication;

  const SECRET = 'topsecret-topsecret-topsecret-topsecret';

  const alias = {
    id: 'al_1',
    consumerId: 'consumer_1',
    name: 'emanuel250',
    displayName: 'emanuel250',
    email: 'owner@example.com',
    emailVerifiedAt: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) =>
      typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    alias: { findUnique: jest.fn() },
    aliasRecovery: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'rec_1' }),
    },
  };

  beforeAll(async () => {
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prismaMock.alias.findUnique.mockReset().mockResolvedValue(alias);
    prismaMock.aliasRecovery.create.mockClear();
  });

  const http = () => app.getHttpServer();
  const path = '/v1/aliases/emanuel250/recovery';

  /** An ordinary API key — an `admin` one, which clears every scope check. */
  const apiKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'admin');

  /** The platform console. */
  const asConsole = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_console')
      .set('x-cosmos-internal', '1');

  it('refuses an API-key caller before looking the alias up', async () => {
    const res = await apiKey(
      request(http()).post(path).send({ email: 'owner@example.com' }),
    ).expect(403);

    expect(res.body.code).toBe('admin_console_only');
    expect(res.body).not.toHaveProperty('token');
    expect(prismaMock.alias.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.aliasRecovery.create).not.toHaveBeenCalled();
  });

  it('refuses the internal marker when the call did not come through the gateway', async () => {
    const res = await request(http())
      .post(path)
      .set('x-cosmos-internal', '1')
      .send({ email: 'owner@example.com' })
      .expect(403);

    expect(res.body.code).toBe('gateway_required');
    expect(prismaMock.alias.findUnique).not.toHaveBeenCalled();
  });

  it('hands the console a token for a matching mailbox', async () => {
    const res = await asConsole(
      request(http()).post(path).send({ email: 'OWNER@example.com' }),
    ).expect(201);

    expect(res.body.accepted).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.email).toBe('owner@example.com');
    expect(prismaMock.aliasRecovery.create).toHaveBeenCalledTimes(1);
  });

  it('answers the console identically when the mailbox does not match', async () => {
    const res = await asConsole(
      request(http()).post(path).send({ email: 'guess@example.com' }),
    ).expect(201);

    expect(res.body).toEqual({
      accepted: true,
      token: null,
      email: null,
      expiresAt: null,
    });
    expect(prismaMock.aliasRecovery.create).not.toHaveBeenCalled();
  });
});
