import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * `GET /v1/public-key` — where a wallet with no account gets the shared key.
 *
 * The claim this suite pins is that it is reachable with NO credential: the
 * caller by definition holds no key yet, and the route used to live on the
 * developer platform precisely because the gateway admitted nothing without one.
 * It also must not resolve a consumer — `@Public()` routes have none, whatever
 * header a client sends.
 */
describe('Public key (e2e)', () => {
  let app: INestApplication;

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    consumer: { upsert: jest.fn() },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
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
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();

  it('serves the key to a caller with no gateway secret and no key', async () => {
    const res = await request(http()).get('/v1/public-key?env=dev').expect(200);
    expect(res.body).toEqual({
      env: 'dev',
      apiKey: process.env.PUBLIC_API_KEY_DEV,
    });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('defaults to the dev key', async () => {
    const res = await request(http()).get('/v1/public-key').expect(200);
    expect(res.body.env).toBe('dev');
  });

  it('answers 503 misconfigured for an environment that publishes no key', async () => {
    const res = await request(http())
      .get('/v1/public-key?env=prod')
      .expect(503);
    expect(res.body.code).toBe('misconfigured');
  });

  it('refuses an unknown environment', async () => {
    await request(http()).get('/v1/public-key?env=staging').expect(400);
  });

  it('resolves no consumer, even when a client claims one', async () => {
    await request(http())
      .get('/v1/public-key?env=dev')
      .set('x-consumer-username', 'cosmos_u1')
      .expect(200);
    expect(prismaMock.consumer.upsert).not.toHaveBeenCalled();
  });
});
