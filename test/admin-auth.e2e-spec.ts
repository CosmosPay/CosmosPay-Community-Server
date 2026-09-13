import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { AdminService } from '@/admin/admin.service';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Platform-admin auth + audit.
 *
 * The gate is "did this call come from the platform console?" — the gateway
 * secret (ApisixGuard) plus the internal marker APISIX strips from everything it
 * proxies. There is no admin secret to deploy: an owner who can change another
 * account's plan and role in the console can also read and act here, which is
 * exactly what a second credential kept breaking.
 *
 * For every admin endpoint:
 *   - a gateway call without the console marker → 403
 *   - a console call → 2xx, and every mutation leaves an audit row naming the
 *     console account that made it
 *
 * Also proves the legacy plaintext `X-Cosmos-Admin: 1` marker grants nothing,
 * that a stale `Authorization: Bearer <old admin secret>` is not a way in, and
 * that audit logs are consultable with no DELETE route.
 */
describe('Admin auth & audit (e2e)', () => {
  let app: INestApplication;
  const auditRows: any[] = [];

  const adminServiceMock = {
    summary: jest.fn().mockResolvedValue({ ok: true }),
    setReceiverAccess: jest.fn(
      async (
        _id: string,
        disabled: boolean,
        actor: { id: string; role: string },
      ) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.setAccess',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: { disabled },
        });
        return { id: 'rcv_1', disabled };
      },
    ),
    approveReceiver: jest.fn(
      async (
        _id: string,
        redirect_url: string,
        actor: { id: string; role: string },
      ) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.approve',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: { redirect_url },
        });
        return { id: 'rcv_1', url: 'https://tos' };
      },
    ),
    enableReceiver: jest.fn(
      async (
        _id: string,
        tos_id: string,
        actor: { id: string; role: string },
      ) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.enable',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: { tos_id },
        });
        return { id: 'rcv_1', status: 'active' };
      },
    ),
    requestReceiverTos: jest.fn(
      async (
        _id: string,
        dto: { redirect_url: string; channel?: string },
        actor: { id: string; role: string },
      ) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.requestTos',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: {
            channel: dto.channel ?? 'code',
            redirect_url: dto.redirect_url,
          },
        });
        return { id: 'rcv_1', url: 'https://tos', email: 'a@b.c' };
      },
    ),
  };

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock);
      return Promise.all(arg);
    },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    adminAuditLog: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        auditRows.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() =>
        Promise.resolve(
          [...auditRows].sort((a, b) => b.createdAt - a.createdAt),
        ),
      ),
      count: jest.fn(() => Promise.resolve(auditRows.length)),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(AdminService)
      .useValue(adminServiceMock)
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

  const http = () => app.getHttpServer();
  const base = '/v1/admin';

  /** A gateway-authenticated caller — an ordinary API key, not the console. */
  const gateway = (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret-topsecret-topsecret-topsecret')
      .set('x-consumer-username', 'cosmos_u1');

  /** The platform console, acting for a signed-in owner. */
  const asConsole = (r: request.Test) =>
    gateway(r)
      .set('x-cosmos-internal', '1')
      .set('x-cosmos-admin-role', 'owner');

  const mutators: Array<{
    name: string;
    method: 'patch' | 'post';
    path: string;
    body: Record<string, unknown>;
    action: string;
  }> = [
    {
      name: 'PATCH receivers/:id/access',
      method: 'patch',
      path: `${base}/receivers/rcv_1/access`,
      body: { disabled: true },
      action: 'receivers.setAccess',
    },
    {
      name: 'POST receivers/:id/approve',
      method: 'post',
      path: `${base}/receivers/rcv_1/approve`,
      body: { redirect_url: 'https://app.example/return' },
      action: 'receivers.approve',
    },
    {
      name: 'POST receivers/:id/enable',
      method: 'post',
      path: `${base}/receivers/rcv_1/enable`,
      body: { tos_id: 'to_abc123' },
      action: 'receivers.enable',
    },
    {
      name: 'POST receivers/:id/tos',
      method: 'post',
      path: `${base}/receivers/rcv_1/tos`,
      body: { redirect_url: 'https://app.example/return' },
      action: 'receivers.requestTos',
    },
  ];

  it('rejects legacy plaintext X-Cosmos-Admin: 1 with 403', async () => {
    await gateway(request(http()).get(`${base}/summary`))
      .set('x-cosmos-admin', '1')
      .expect(403);
  });

  it('rejects a stale admin Bearer secret with 403', async () => {
    await gateway(request(http()).get(`${base}/summary`))
      .set('Authorization', 'Bearer write-secret-00000')
      .expect(403);
  });

  it('rejects an ordinary gateway caller on a read endpoint', async () => {
    await gateway(request(http()).get(`${base}/summary`)).expect(403);
  });

  it('allows the console on a read endpoint', async () => {
    await asConsole(request(http()).get(`${base}/summary`)).expect(200);
  });

  describe.each(mutators)('$name', ({ method, path, body, action }) => {
    it('returns 403 for a caller that is not the console', async () => {
      await gateway(request(http())[method](path).send(body)).expect(403);
    });

    it('allows the console and appends an audit row naming the account', async () => {
      const before = auditRows.length;
      await asConsole(request(http())[method](path).send(body)).expect(
        (res) => {
          if (res.status < 200 || res.status >= 300) {
            throw new Error(
              `expected 2xx, got ${res.status}: ${JSON.stringify(res.body)}`,
            );
          }
        },
      );
      expect(auditRows.length).toBe(before + 1);
      expect(auditRows[auditRows.length - 1]).toMatchObject({
        actorId: 'cosmos_u1',
        actorRole: 'owner',
        action,
        resourceType: 'receiver',
        resourceId: 'rcv_1',
      });
    });
  });

  it('exposes consultable audit logs to the console', async () => {
    const res = await asConsole(
      request(http()).get(`${base}/audit-logs`),
    ).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('does not expose a DELETE route for audit logs', async () => {
    await asConsole(request(http()).delete(`${base}/audit-logs`)).expect(404);
    await asConsole(
      request(http()).delete(`${base}/audit-logs/audit_1`),
    ).expect(404);
  });
});
