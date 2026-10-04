import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The HTTP wiring of Solana and Monad: the request DTOs hold an address to
 * the chain it names, refuse Stellar-only fields elsewhere, and an unknown
 * chain is a 400 — all before any RPC is called (none is reachable here).
 */
describe('Solana and Monad wiring (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const SOL_DEST = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN';
  const EVM_DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    paymentIntent: { findUnique: jest.fn().mockResolvedValue(null) },
    rateLimitCounter: {
      upsert: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
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
  const asTenant = (r: request.Test) =>
    r
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-role', 'admin')
      .set('x-consumer-environment', 'dev')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  it('refuses an address of another chain than the one named', async () => {
    const res = await asTenant(
      request(http()).post('/v1/payment-intents/pay'),
    ).send({ chain: 'solana', destination: STELLAR, amount: '1' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain(
      'destination must be a valid Solana address (base58, 32 bytes) for chain solana',
    );
  });

  it('refuses a chain it does not know', async () => {
    const res = await asTenant(
      request(http()).post('/v1/payment-intents/pay'),
    ).send({ chain: 'bitcoin', destination: SOL_DEST });
    expect(res.status).toBe(400);
  });

  it('refuses a SEP-7 callback off Stellar before any chain is asked', async () => {
    const res = await asTenant(
      request(http()).post('/v1/payment-intents/pay'),
    ).send({
      chain: 'solana',
      destination: SOL_DEST,
      callback: 'url:https://merchant.example/cb',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('refuses an open amount on Monad', async () => {
    const res = await asTenant(
      request(http()).post('/v1/payment-intents/pay'),
    ).send({ chain: 'monad', destination: EVM_DEST });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_amount');
  });

  it('refuses a transaction id of no chain at all', async () => {
    const res = await asTenant(
      request(http()).post('/v1/payment-intents/pi_1/validate'),
    ).send({ txHash: 'not-a-hash' });
    expect(res.status).toBe(400);
  });

  it('refuses an unknown chain on alias resolution', async () => {
    const res = await asTenant(
      request(http()).get('/v1/aliases/resolve/alice?chain=bitcoin'),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });
});
