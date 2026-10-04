import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

/**
 * A deployment that does not list a native plugin in PLUGINS_ENABLED does not
 * have it: its routes are not registered at all (404, not 403 or 503), and its
 * section of the admin summary is absent. The other suites run with `blindpay`
 * and `defindex` enabled; this one boots the app without them.
 */
describe('Native plugins switched off (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
  };

  beforeAll(async () => {
    // Before the app module is loaded: which native modules exist is decided
    // when it is, from the environment.
    process.env.PLUGINS_ENABLED = 'example';
    const [{ AppModule }, { PrismaService }] = await Promise.all([
      import('../src/app.module'),
      import('../src/prisma/prisma.service'),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const asTenant = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'admin')
      .set(
        'x-consumer-permissions',
        'onramp:read,onramp:write,offramp:read,kyc:read,liquidity:read',
      );

  it.each([
    ['GET', '/v1/onramp/payins'],
    ['GET', '/v1/offramp/payouts'],
    ['GET', '/v1/kyc/receivers'],
    ['GET', '/v1/defindex/vaults'],
    ['POST', '/v1/blindpay/webhooks'],
  ])('does not serve %s %s', async (method, path) => {
    const req =
      method === 'GET'
        ? request(app.getHttpServer()).get(path)
        : request(app.getHttpServer()).post(path);
    await asTenant(req).expect(404);
  });
});
