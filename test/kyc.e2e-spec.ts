import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

process.env.KYC_REDIRECT_URL_WHITELIST = JSON.stringify({
  cosmos_u1: ['app.example.com'],
});

describe('KYC surface (e2e)', () => {
  let app: INestApplication;

  const receiver = {
    id: 'receiver_1',
    consumerId: 'consumer_1',
    blindpayId: 'local_receiver_1',
    type: 'individual',
    kycType: 'standard',
    kycStatus: 'pending_user',
    email: 'jane@example.com',
    name: 'Jane Doe',
    country: 'US',
    externalId: null,
    raw: {},
    disabled: false,
    tosSentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const receiverUpdateMock = jest.fn().mockResolvedValue(receiver);
  // `requestTos` claims the send with a compare-and-swap UPDATE and treats
  // `count === 0` as "someone else already sent it", so the mock has to report
  // the row as claimed for the happy path.
  const receiverClaimMock = jest.fn().mockResolvedValue({ count: 1 });
  const transactionClient = {
    blindpayReceiver: {
      update: receiverUpdateMock,
      updateMany: receiverClaimMock,
      findUniqueOrThrow: jest.fn().mockResolvedValue(receiver),
    },
  };

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(
      (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
    ),
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'request_log_1' }),
    },
    consumer: {
      upsert: jest.fn().mockResolvedValue({
        id: 'consumer_1',
        apisixUsername: 'cosmos_u1',
        credentialId: null,
      }),
      findUnique: jest.fn().mockResolvedValue({ apisixUsername: 'cosmos_u1' }),
    },
    blindpayReceiver: {
      findMany: jest.fn().mockResolvedValue([receiver]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(
        ({ where }: { where: { id: string; consumerId?: string } }) =>
          where.id === receiver.id && where.consumerId === receiver.consumerId
            ? Promise.resolve(receiver)
            : Promise.resolve(null),
      ),
      findUnique: jest.fn().mockResolvedValue(receiver),
      update: receiverUpdateMock,
    },
  };

  const blindpayMock = {
    instanceId: 'instance_1',
    isConfigured: true,
    instancePath: jest.fn((path: string) => `/instances/instance_1${path}`),
    get: jest.fn(),
    post: jest.fn().mockResolvedValue({ url: 'https://tos.example/accept' }),
    put: jest.fn(),
    delete: jest.fn(),
    uploadFile: jest.fn(),
  };

  beforeAll(async () => {
    const [{ AppModule }, { PrismaService }, { BlindpayClient }] =
      await Promise.all([
        import('../src/app.module'),
        import('../src/prisma/prisma.service'),
        import('../src/blindpay/blindpay.client'),
      ]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(BlindpayClient)
      .useValue(blindpayMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // Must match APISIX_GATEWAY_SECRET in test/setup-env.ts — ApisixGuard now
  // enforces a minimum length, so the old short literal is rejected outright.
  const GATEWAY_SECRET = 'topsecret-topsecret-topsecret-topsecret';
  const http = () => app.getHttpServer();
  const receiverPath = '/v1/kyc/receivers';

  it('rejects a KYC request without the gateway secret', () =>
    request(http())
      .get(receiverPath)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'kyc:read')
      .expect(403));

  it('rejects a request without an authenticated consumer', () =>
    request(http())
      .get(receiverPath)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-permissions', 'kyc:read')
      .expect(401));

  it('requires the declared KYC permission', () =>
    request(http())
      .get(receiverPath)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'payments:read')
      .expect(403)
      .expect(({ body }) => {
        expect(body.message).toContain('kyc:read');
      }));

  it('lists only the authenticated consumer records', async () => {
    await request(http())
      .get(receiverPath)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'kyc:read')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ total: 1 });
      });

    expect(prismaMock.blindpayReceiver.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { consumerId: 'consumer_1' } }),
    );
  });

  it('does not expose another consumer receiver', async () => {
    await request(http())
      .get(`${receiverPath}/foreign_receiver`)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'kyc:read')
      .expect(404);

    expect(prismaMock.blindpayReceiver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'foreign_receiver', consumerId: 'consumer_1' },
      }),
    );
  });

  it('ignores a cooldown override without the trusted internal marker', () =>
    request(http())
      .post(`${receiverPath}/${receiver.id}/tos`)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'kyc:write')
      .set('x-cosmos-tos-cooldown-ms', '0')
      .send({
        channel: 'email',
        redirect_url: 'https://app.example.com/kyc/return',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('already sent');
      }));

  it('ignores a cooldown override from a marker alone, without the role', () =>
    request(http())
      .post(`${receiverPath}/${receiver.id}/tos`)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'kyc:write')
      .set('x-cosmos-internal', '1')
      .set('x-cosmos-tos-cooldown-ms', '0')
      .send({
        channel: 'email',
        redirect_url: 'https://app.example.com/kyc/return',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('already sent');
      }));

  it('honors the dashboard cooldown only with the trusted internal marker', async () => {
    await request(http())
      .post(`${receiverPath}/${receiver.id}/tos`)
      .set('x-gateway-secret', GATEWAY_SECRET)
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'kyc:write')
      // The marker is only honoured for an elevated consumer: a request header
      // must not be what grants the privilege, so the admin role is required
      // alongside it.
      .set('x-consumer-role', 'admin')
      .set('x-cosmos-internal', '1')
      .set('x-cosmos-tos-cooldown-ms', '0')
      .send({
        channel: 'email',
        redirect_url: 'https://app.example.com/kyc/return',
      })
      .expect(201)
      .expect({
        url: 'https://tos.example/accept',
        email: receiver.email,
        channel: 'email',
      });

    expect(blindpayMock.post).toHaveBeenCalledTimes(1);
    // The send is recorded with a conditional UPDATE, not a blind one: only the
    // caller whose row still matches wins, which is what caps the KYC subject's
    // inbox at one mail per window. `cooldownMs=0` drops the recency clause.
    expect(receiverClaimMock).toHaveBeenCalledWith({
      where: { id: receiver.id, kycStatus: 'pending_user' },
      data: { tosSentAt: expect.any(Date) },
    });
  });
});
