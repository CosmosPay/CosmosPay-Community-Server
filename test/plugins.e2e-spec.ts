import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The wiring in front of /v1/plugins.
 *
 * `setup-env.ts` enables `example`, the plugin preinstalled in `plugins/`. What is checked here is who reaches a
 * plugin at all: the gateway gate, the two scopes (a read key cannot run a
 * command), the shared public key (refused everywhere — a plugin acts on one
 * tenant's data), consent on install, and that nothing runs before the tenant
 * installed the plugin.
 */
describe('Plugins (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    $queryRaw: jest.fn(() => Promise.resolve([{ count: 1 }])),
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    pluginInstallation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    pluginRecord: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter());
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

  const http = () => app.getHttpServer();

  const asKey = (r: request.Test, permissions: string) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'user')
      .set('x-consumer-permissions', permissions);

  const asPublicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-permissions', 'plugins:read,plugins:write');

  it('refuses a caller that did not come through the gateway', async () => {
    const res = await request(http()).get('/v1/plugins').expect(403);
    expect(res.body.code).toBe('gateway_required');
  });

  it('refuses a key without a plugins scope', async () => {
    await asKey(request(http()).get('/v1/plugins'), 'payments:read').expect(
      403,
    );
    await asKey(
      request(http()).put('/v1/plugins/example/installation'),
      'plugins:read',
    )
      .send({ grantCapabilities: ['payment_intents:read'] })
      .expect(403);
  });

  it('does not let a read key run a command', async () => {
    const res = await asKey(
      request(http()).post('/v1/plugins/example/commands/add-note'),
      'plugins:read',
    )
      .send({ input: { paymentIntentId: 'pi_1', text: 'hi' } })
      .expect(403);
    expect(res.body.code).toBe('insufficient_scope');
  });

  it('refuses the shared public key on every plugin route', async () => {
    await asPublicKey(request(http()).get('/v1/plugins')).expect(403);
    await asPublicKey(
      request(http()).post('/v1/plugins/example/queries/get-notes'),
    )
      .send({ input: { paymentIntentId: 'pi_1' } })
      .expect(403);
  });

  it('lists the enabled plugin, not installed', async () => {
    const res = await asKey(
      request(http()).get('/v1/plugins'),
      'plugins:read',
    ).expect(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        slug: 'example',
        capabilities: ['payment_intents:read'],
        installation: null,
      }),
    ]);
  });

  it('404s a plugin this deployment does not serve', async () => {
    await asKey(
      request(http()).get('/v1/plugins/ghost'),
      'plugins:read',
    ).expect(404);
  });

  it('refuses an install that does not consent to the declared capabilities', async () => {
    const res = await asKey(
      request(http()).put('/v1/plugins/example/installation'),
      'plugins:write',
    )
      .send({ grantCapabilities: ['payment_intents:read', 'customers:write'] })
      .expect(400);
    expect(res.body.code).toBe('plugin_consent_mismatch');
    expect(prismaMock.pluginInstallation.upsert).not.toHaveBeenCalled();
  });

  it('runs nothing for a tenant that has not installed the plugin', async () => {
    const res = await asKey(
      request(http()).post('/v1/plugins/example/queries/get-notes'),
      'plugins:read',
    )
      .send({ input: { paymentIntentId: 'pi_1' } })
      .expect(409);
    expect(res.body.code).toBe('plugin_not_installed');
    expect(prismaMock.pluginRecord.findUnique).not.toHaveBeenCalled();
  });
});
