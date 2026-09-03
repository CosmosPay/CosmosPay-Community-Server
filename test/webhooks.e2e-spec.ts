import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookDestinationGuard } from '@/webhooks/webhook-destination.guard';
import { WebhookHttpClient } from '@/webhooks/webhook-http';

/**
 * Full CRUD for webhook endpoints behind the APISIX gate. Prisma is mocked with
 * a tiny in-memory store; the outbound transport is stubbed for the ping test.
 * No DB/network. (Delivery pins its own socket via https.request, so stubbing
 * global fetch no longer intercepts it — the seam is WebhookHttpClient.)
 */
describe('Webhooks CRUD (e2e)', () => {
  let app: INestApplication;
  const store = new Map<string, any>();
  let seq = 0;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'c1', apisixUsername: 'cosmos_u1' }),
    },
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },
    webhookEndpoint: {
      create: jest.fn(({ data }: any) => {
        const row = {
          // The gateway consumer that created it — what the ownership filter
          // matches on.
          consumerUsername: 'cosmos_u1',
          id: `we_${++seq}`,
          enabled: true,
          destinationBlocked: false,
          description: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.set(row.id, row);
        return Promise.resolve(row);
      }),
      // These honour the consumer filter, as Prisma does. A fake that ignores
      // `where` cannot distinguish "not found" from "someone else's row", which
      // is the only thing standing between two tenants.
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve([...store.values()].filter((r) => owns(r, where))),
      ),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...store.values()].filter((r) => owns(r, where)).length,
        ),
      ),
      findFirst: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        return Promise.resolve(row && owns(row, where) ? row : null);
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = { ...store.get(where.id), ...data, updatedAt: new Date() };
        store.set(where.id, row);
        return Promise.resolve(row);
      }),
      delete: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        store.delete(where.id);
        return Promise.resolve(row);
      }),
    },
    webhookDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  /** Mirrors `where: { consumer: { apisixUsername } }` / `{ consumerId }`. */
  function owns(row: any, where: any): boolean {
    if (!where) return true;
    const username = where.consumer?.apisixUsername;
    if (username !== undefined && row.consumerUsername !== username) {
      return false;
    }
    if (where.consumerId !== undefined && row.consumerId !== where.consumerId) {
      return false;
    }
    return true;
  }

  const webhookHttp = {
    send: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  };

  beforeAll(async () => {
    const destinations = new WebhookDestinationGuard();
    destinations.replaceDnsLookup(async () => ['93.184.216.34']);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(WebhookDestinationGuard)
      .useValue(destinations)
      .overrideProvider(WebhookHttpClient)
      .useValue(webhookHttp)
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
  const route = '/v1/webhooks';
  const gw = (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret-topsecret-topsecret-topsecret')
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'webhooks:read,webhooks:write');

  let id: string;

  it('rejects creation without the gateway secret (403)', () =>
    request(http())
      .post(route)
      .send({ url: 'https://x.example.com/h' })
      .expect(403));

  it('rejects an invalid url (400)', () =>
    gw(request(http()).post(route).send({ url: 'not-a-url' })).expect(400));

  it('rejects a loopback / private / metadata destination (400)', async () => {
    const loopback = await gw(
      request(http()).post(route).send({ url: 'https://127.0.0.1/hooks' }),
    ).expect(400);
    expect(loopback.body.message).toEqual(expect.stringMatching(/loopback/i));

    const privateRange = await gw(
      request(http()).post(route).send({ url: 'https://10.0.0.5/hooks' }),
    ).expect(400);
    expect(privateRange.body.message).toEqual(
      expect.stringMatching(/private/i),
    );

    const metadata = await gw(
      request(http())
        .post(route)
        .send({ url: 'https://169.254.169.254/latest/meta-data' }),
    ).expect(400);
    expect(metadata.body.message).toEqual(
      expect.stringMatching(/link-local|cloud-metadata/i),
    );
  });

  it('creates an endpoint (201) and returns the signing secret', async () => {
    const res = await gw(
      request(http())
        .post(route)
        .send({
          url: 'https://integrator.example.com/hook',
          eventTypes: ['PAYMENT_INTENT_CREATED'],
        }),
    ).expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.secret).toMatch(/^whsec_/);
    id = res.body.id;
  });

  it('list/get never expose the secret', async () => {
    const list = await gw(request(http()).get(route)).expect(200);
    // The list is the standard { data, total, take, skip } envelope, like every
    // other list in this API. It used to be a bare array clamped at 100, which
    // truncated silently with no total to page against.
    expect(list.body.total).toBeGreaterThan(0);
    expect(list.body.take).toBe(100);
    expect(list.body.skip).toBe(0);
    expect(list.body.data[0].secret).toBeUndefined();
    const one = await gw(request(http()).get(`${route}/${id}`)).expect(200);
    expect(one.body.id).toBe(id);
    expect(one.body.secret).toBeUndefined();
  });

  it('404s for another tenant, not just for an unknown id', async () => {
    // The existing "foreign/unknown id" test only sends an id that does not
    // exist, which proves *unknown*, never *foreign*. This one seeds a real
    // endpoint owned by cosmos_u1 and asks for it as cosmos_u2 — the case that
    // would expose another organization's signing secret via rotate-secret.
    const asOtherTenant = (req: request.Test) =>
      req
        .set('x-gateway-secret', 'topsecret-topsecret-topsecret-topsecret')
        .set('x-consumer-username', 'cosmos_u2')
        .set('x-consumer-permissions', 'webhooks:read,webhooks:write');

    await asOtherTenant(request(http()).get(`${route}/${id}`)).expect(404);
    await asOtherTenant(
      request(http()).patch(`${route}/${id}`).send({ enabled: false }),
    ).expect(404);
    await asOtherTenant(
      request(http()).post(`${route}/${id}/rotate-secret`),
    ).expect(404);
    await asOtherTenant(request(http()).delete(`${route}/${id}`)).expect(404);

    // And the list is scoped too — the other tenant sees none of it.
    const list = await asOtherTenant(request(http()).get(route)).expect(200);
    expect(list.body.data).toHaveLength(0);
    expect(list.body.total).toBe(0);
  });

  it('updates (pause) an endpoint (200)', async () => {
    const res = await gw(
      request(http()).patch(`${route}/${id}`).send({ enabled: false }),
    ).expect(200);
    expect(res.body.enabled).toBe(false);
  });

  it('rotates the secret (200) returning a new secret', async () => {
    const res = await gw(
      request(http()).post(`${route}/${id}/rotate-secret`),
    ).expect(201);
    expect(res.body.secret).toMatch(/^whsec_/);
  });

  it('pings the endpoint (stubbed transport → ok)', async () => {
    webhookHttp.send.mockResolvedValue({ ok: true, status: 200 });
    const res = await gw(request(http()).post(`${route}/${id}/ping`)).expect(
      201,
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.responseStatus).toBe(200);
  });

  it('404s on a foreign/unknown id', () =>
    gw(request(http()).get(`${route}/nope`)).expect(404));

  it('deletes (200) then 404s on read', async () => {
    await gw(request(http()).delete(`${route}/${id}`)).expect(200);
    await gw(request(http()).get(`${route}/${id}`)).expect(404);
  });
});
