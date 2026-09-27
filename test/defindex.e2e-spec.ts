import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The wiring in front of /v1/defindex, with no DeFindex key configured.
 *
 * The routes are served at /v1/defindex — the path the wallet calls. They were
 * once declared as `v1/defindex` under URI versioning and served at
 * /v1/v1/defindex, where no client looked. With no `DEFINDEX_API_KEY` a caller
 * that gets past the guards meets `503 misconfigured`, never an upstream call.
 */
describe('DeFindex guards (e2e)', () => {
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

  /** The shared public key, which every DeFindex route admits. */
  const asPublicKey = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_public')
      .set('x-consumer-role', 'public')
      .set('x-consumer-permissions', 'liquidity:read,liquidity:write');

  it('refuses a caller that did not come through the gateway', async () => {
    const res = await request(http()).get('/v1/defindex/vaults').expect(403);

    expect(res.body.code).toBe('gateway_required');
  });

  it('serves the vault list at /v1/defindex, and says DeFindex is off', async () => {
    const res = await asPublicKey(request(http()).get('/v1/defindex/vaults'));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('misconfigured');
  });

  it('does not serve the doubled /v1/v1/defindex prefix', async () => {
    await asPublicKey(request(http()).get('/v1/v1/defindex/vaults')).expect(
      404,
    );
  });

  it('refuses a key without a liquidity or swaps scope', async () => {
    await request(http())
      .get('/v1/defindex/vaults')
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'user')
      .set('x-consumer-permissions', 'payments:read')
      .expect(403);
  });
});
