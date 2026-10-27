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
 * `/v1/customers`: a customer holds wallets on any chain the service settles, and the deprecated
 * `account` still names one. The rules are the DTO spec's and the spelling the service spec's;
 * this suite pins them through the real pipe: the scope gate, the three shapes admitted, the
 * refusal an integrator reads, the EIP-55 spelling that reaches the database, and the wallet
 * routes' gates.
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
        Promise.resolve({
          id: 'cus_1',
          name: data.name,
          wallets: data.wallets.create.map(
            (w: { chain: string; address: string; label?: string | null }) => ({
              id: 'w_1',
              chain: w.chain,
              address: w.address,
              label: w.label ?? null,
            }),
          ),
        }),
      ),
      // cus_1 is this consumer's, with one Stellar wallet; anything else is not.
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(
          where.id === 'cus_1'
            ? {
                id: 'cus_1',
                wallets: [{ id: 'w_1', chain: 'stellar', address: STELLAR }],
              }
            : null,
        ),
      ),
      update: jest.fn(() => Promise.resolve({ id: 'cus_1', wallets: [] })),
    },
    customerWallet: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) =>
        Promise.resolve({
          id: 'w_2',
          chain: data.chain,
          address: data.address,
          label: data.label,
        }),
      ),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
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
    prismaMock.customerWallet.create.mockClear();
    prismaMock.customerWallet.update.mockClear();
    prismaMock.customerWallet.delete.mockClear();
  });

  const tenant = (
    method: 'post' | 'patch' | 'delete',
    path: string,
    scopes: string,
  ) =>
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
    expect(res.body.wallets).toEqual([
      expect.objectContaining({ address: stored }),
    ]);
    expect(
      prismaMock.customer.create.mock.calls[0][0].data.wallets.create[0]
        .address,
    ).toBe(stored);
  });

  it('creates a customer with wallets on several chains', async () => {
    const res = await tenant('post', '/v1/customers', 'customers:write')
      .send({
        name: 'Ada',
        wallets: [
          { chain: 'solana', address: SOLANA, label: 'Phantom' },
          { chain: 'monad', address: MONAD.toLowerCase() },
        ],
      })
      .expect(201);

    expect(
      res.body.wallets.map((w: { chain: string; address: string }) => [
        w.chain,
        w.address,
      ]),
    ).toEqual([
      ['solana', SOLANA],
      ['monad', MONAD],
    ]);
    expect(res.body.account).toBe(SOLANA);
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

  it("refuses a wallet whose address is not its chain's (400)", async () => {
    const res = await tenant('post', '/v1/customers', 'customers:write')
      .send({ name: 'Ada', wallets: [{ chain: 'monad', address: SOLANA }] })
      .expect(400);

    expect(res.body.message).toEqual([
      'wallets.0.address must be a valid Monad (EVM) address (0x + 40 hex) for chain monad',
    ]);
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });

  it('normalizes the account on an update too: it replaces the first wallet', async () => {
    await tenant('patch', '/v1/customers/cus_1', 'customers:write')
      .send({ account: MONAD.toLowerCase() })
      .expect(200);

    expect(prismaMock.customerWallet.update).toHaveBeenCalledWith({
      where: { id: 'w_1' },
      data: { chain: 'monad', address: MONAD },
    });
  });

  it('refuses wallets on an update: they have their own routes (400)', async () => {
    await tenant('patch', '/v1/customers/cus_1', 'customers:write')
      .send({ wallets: [{ chain: 'stellar', address: STELLAR }] })
      .expect(400);
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  describe('wallet routes', () => {
    it('refuse a key without customers:write (403)', async () => {
      await tenant('post', '/v1/customers/cus_1/wallets', 'customers:read')
        .send({ chain: 'solana', address: SOLANA })
        .expect(403);
      await tenant(
        'delete',
        '/v1/customers/cus_1/wallets/w_1',
        'customers:read',
      ).expect(403);
      expect(prismaMock.customerWallet.create).not.toHaveBeenCalled();
      expect(prismaMock.customerWallet.delete).not.toHaveBeenCalled();
    });

    it("adds a wallet in its chain's spelling (201)", async () => {
      const res = await tenant(
        'post',
        '/v1/customers/cus_1/wallets',
        'customers:write',
      )
        .send({ chain: 'monad', address: MONAD.toLowerCase(), label: 'Rabby' })
        .expect(201);

      expect(res.body).toMatchObject({
        chain: 'monad',
        address: MONAD,
        label: 'Rabby',
      });
    });

    it('answers a customer of someone else, and a wallet not on the customer, as missing (404)', async () => {
      await tenant('post', '/v1/customers/cus_other/wallets', 'customers:write')
        .send({ chain: 'solana', address: SOLANA })
        .expect(404);
      await tenant(
        'delete',
        '/v1/customers/cus_1/wallets/w_9',
        'customers:write',
      ).expect(404);
      expect(prismaMock.customerWallet.delete).not.toHaveBeenCalled();
    });

    it('refuses a wallet another customer holds (409 customer_wallet_taken)', async () => {
      prismaMock.customerWallet.findFirst.mockResolvedValueOnce({
        chain: 'solana',
        address: SOLANA,
        customerId: 'cus_2',
      });

      const res = await tenant(
        'post',
        '/v1/customers/cus_1/wallets',
        'customers:write',
      )
        .send({ chain: 'solana', address: SOLANA })
        .expect(409);

      expect(res.body.code).toBe('customer_wallet_taken');
    });

    it('removes a wallet of the customer', async () => {
      const res = await tenant(
        'delete',
        '/v1/customers/cus_1/wallets/w_1',
        'customers:write',
      ).expect(200);
      expect(res.body).toEqual({ id: 'w_1', deleted: true });
    });
  });
});
