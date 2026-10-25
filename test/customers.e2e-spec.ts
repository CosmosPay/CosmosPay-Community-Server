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
 * `POST` and `PATCH /v1/customers`: a customer's `account` is an address on any chain the
 * service settles. The rule is the DTO spec's and the spelling the service spec's; this suite
 * pins them through the real pipe: the scope gate, the three shapes admitted, the refusal an
 * integrator reads, and the EIP-55 spelling that reaches the database.
 */
describe('Customers (e2e)', () => {
  let app: INestApplication;
  const SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
  const SOLANA = 'So11111111111111111111111111111111111111112';
  const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    customer: {
      // Answers with what it was asked to store, as the database would.
      create: jest.fn(({ data }) =>
        Promise.resolve({ id: 'cus_1', ...data, consumerId: undefined }),
      ),
      findFirst: jest.fn().mockResolvedValue({ id: 'cus_1' }),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'cus_1', ...data })),
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
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prismaMock.customer.create.mockClear();
    prismaMock.customer.update.mockClear();
  });

  const tenant = (method: 'post' | 'patch', path: string, scopes: string) =>
    request(app.getHttpServer())
      [method](path)
      .set('x-gateway-secret', SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', scopes);

  it('refuses a key without customers:write (403)', async () => {
    await tenant('post', '/v1/customers', 'customers:read')
      .send({ name: 'Ada', account: STELLAR })
      .expect(403);
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });

  it.each([
    ['Stellar', STELLAR, STELLAR],
    ['Solana', SOLANA, SOLANA],
    ['Monad, stored EIP-55', MONAD.toLowerCase(), MONAD],
  ])('creates a customer with a %s account', async (_, sent, stored) => {
    const res = await tenant('post', '/v1/customers', 'customers:write')
      .send({ name: 'Ada', account: sent })
      .expect(201);

    expect(res.body.account).toBe(stored);
    expect(prismaMock.customer.create.mock.calls[0][0].data.account).toBe(
      stored,
    );
  });

  it('refuses an address no chain accepts, naming the three shapes (400)', async () => {
    const res = await tenant('post', '/v1/customers', 'customers:write')
      .send({ name: 'Ada', account: MONAD.slice(0, -1) })
      .expect(400);

    expect(res.body.message).toEqual([
      'account must be a valid Stellar account address (G...), a valid Solana address ' +
        '(base58, 32 bytes) or a valid Monad (EVM) address (0x + 40 hex)',
    ]);
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });

  it('normalizes the account on an update too', async () => {
    const res = await tenant('patch', '/v1/customers/cus_1', 'customers:write')
      .send({ account: MONAD.toLowerCase() })
      .expect(200);

    expect(res.body.account).toBe(MONAD);
    expect(prismaMock.customer.update.mock.calls[0][0].data).toEqual({
      account: MONAD,
    });
  });
});
