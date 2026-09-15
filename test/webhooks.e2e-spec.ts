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
import {
  WEBHOOK_PING_RATE_LIMIT,
  WEBHOOK_REDELIVER_RATE_LIMIT,
} from '@/webhooks/webhooks.constants';

/**
 * Full CRUD for webhook endpoints behind the APISIX gate. Prisma is mocked with
 * a tiny in-memory store; the outbound transport is stubbed for the ping test.
 * No DB/network. (Delivery pins its own socket via https.request, so stubbing
 * global fetch no longer intercepts it — the seam is WebhookHttpClient.)
 */
describe('Webhooks CRUD (e2e)', () => {
  let app: INestApplication;
  const store = new Map<string, any>();
  const counters = new Map<string, number>();
  let seq = 0;

  /** What Prisma answers for a `select`: those columns only, or the whole row. */
  function project(row: any, select?: Record<string, boolean>) {
    if (!row || !select) return row;
    return Object.fromEntries(
      Object.keys(select)
        .filter((key) => select[key])
        .map((key) => [key, row[key]]),
    );
  }

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    // The rate limiter's atomic upsert, as an in-memory counter.
    $queryRaw: jest.fn((_parts: unknown, key: string, windowStart: Date) => {
      const bucket = `${key}|${windowStart.getTime()}`;
      const next = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, next);
      return Promise.resolve([{ count: next }]);
    }),
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'c1', apisixUsername: 'cosmos_u1' }),
    },
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },
    webhookEndpoint: {
      // Rows carry every column the real table has, so a response that is not
      // projected hands them straight back and the key-set assertions see it.
      // `select` is honoured, as Prisma honours it.
      create: jest.fn(({ data, select }: any) => {
        const row = {
          // The gateway consumer that created it — what the ownership filter
          // matches on.
          consumerUsername: 'cosmos_u1',
          id: `we_${++seq}`,
          enabled: true,
          destinationBlocked: false,
          previousSecret: null,
          previousSecretExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
          // An unset optional column is NULL in Postgres, not absent.
          description: data.description ?? null,
        };
        store.set(row.id, row);
        return Promise.resolve(project(row, select));
      }),
      // These honour the consumer filter, as Prisma does. A fake that ignores
      // `where` cannot distinguish "not found" from "someone else's row", which
      // is the only thing standing between two tenants.
      findMany: jest.fn(({ where, select }: any) =>
        Promise.resolve(
          [...store.values()]
            .filter((r) => owns(r, where))
            .map((r) => project(r, select)),
        ),
      ),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...store.values()].filter((r) => owns(r, where)).length,
        ),
      ),
      findFirst: jest.fn(({ where, select }: any) => {
        const row = store.get(where.id);
        return Promise.resolve(
          row && owns(row, where) ? project(row, select) : null,
        );
      }),
      update: jest.fn(({ where, data, select }: any) => {
        const row = { ...store.get(where.id), ...data, updatedAt: new Date() };
        store.set(where.id, row);
        return Promise.resolve(project(row, select));
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
      findFirst: jest.fn().mockResolvedValue(null),
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

  /** The documented `WebhookEndpointEntity` fields — the whole response. */
  const PUBLIC_KEYS = [
    'createdAt',
    'description',
    'destinationBlocked',
    'enabled',
    'eventTypes',
    'id',
    'updatedAt',
    'url',
  ];
  /** `WebhookEndpointWithSecretEntity`: create and rotate-secret only. */
  const WITH_SECRET_KEYS = [...PUBLIC_KEYS, 'secret'].sort();
  const PREVIOUS_SECRET = 'whsec_previous_still_accepted';

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
    // Taken first, so a failed assertion below does not cascade into every
    // later test that reuses this endpoint.
    id = res.body.id;
    expect(res.body.id).toBeDefined();
    expect(res.body.secret).toMatch(/^whsec_/);
    // The documented entity and nothing more — no internal `consumerId`.
    expect(Object.keys(res.body).sort()).toEqual(WITH_SECRET_KEYS);
  });

  it('list/get never expose a signing secret, current or previous', async () => {
    // The row as main's grace-window rotation leaves it: the previous secret is
    // still stored, and an integrator mid-rotation still accepts it. Anything
    // holding `webhooks:read` could forge events with it if it came back here.
    Object.assign(store.get(id), {
      previousSecret: PREVIOUS_SECRET,
      previousSecretExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const list = await gw(request(http()).get(route)).expect(200);
    // The list is the standard { data, total, take, skip } envelope, like every
    // other list in this API. It used to be a bare array clamped at 100, which
    // truncated silently with no total to page against.
    expect(list.body.total).toBeGreaterThan(0);
    expect(list.body.take).toBe(100);
    expect(list.body.skip).toBe(0);
    expect(list.body.data[0].secret).toBeUndefined();
    expect(list.body.data[0]).not.toHaveProperty('previousSecret');
    expect(list.body.data[0]).not.toHaveProperty('previousSecretExpiresAt');
    expect(Object.keys(list.body.data[0]).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(list.body)).not.toContain('whsec_');

    const one = await gw(request(http()).get(`${route}/${id}`)).expect(200);
    expect(one.body.id).toBe(id);
    expect(one.body.secret).toBeUndefined();
    expect(one.body).not.toHaveProperty('previousSecret');
    expect(one.body).not.toHaveProperty('previousSecretExpiresAt');
    expect(Object.keys(one.body).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(one.body)).not.toContain('whsec_');
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
    // The stored row still holds the previous secret; the response does not.
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(res.body)).not.toContain('whsec_');
  });

  it('rotates the secret (200) returning a new secret', async () => {
    const res = await gw(
      request(http()).post(`${route}/${id}/rotate-secret`),
    ).expect(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    // The new secret once — never the previous one still stored on the row.
    expect(Object.keys(res.body).sort()).toEqual(WITH_SECRET_KEYS);
    expect(res.body).not.toHaveProperty('previousSecret');
    expect(JSON.stringify(res.body)).not.toContain(PREVIOUS_SECRET);
  });

  it('pings the endpoint (stubbed transport → ok)', async () => {
    webhookHttp.send.mockResolvedValue({ ok: true, status: 200 });
    const res = await gw(request(http()).post(`${route}/${id}/ping`)).expect(
      201,
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.responseStatus).toBe(200);
  });

  describe('rate limits on the routes that send outbound requests', () => {
    beforeEach(() => {
      counters.clear();
    });

    it('caps ping, and refuses before anything is sent', async () => {
      const { limit } = WEBHOOK_PING_RATE_LIMIT;
      webhookHttp.send.mockClear();

      for (let i = 0; i < limit; i++) {
        const res = await gw(
          request(http()).post(`${route}/${id}/ping`),
        ).expect(201);
        expect(Number(res.headers['ratelimit-limit'])).toBe(limit);
        expect(Number(res.headers['ratelimit-remaining'])).toBe(limit - 1 - i);
      }
      expect(webhookHttp.send).toHaveBeenCalledTimes(limit);

      const refused = await gw(
        request(http()).post(`${route}/${id}/ping`),
      ).expect(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      // Refused in the guard: the extra call sent nothing to the integrator.
      expect(webhookHttp.send).toHaveBeenCalledTimes(limit);
    });

    it('caps redelivery, and refuses before the delivery is loaded', async () => {
      const { limit } = WEBHOOK_REDELIVER_RATE_LIMIT;
      const redeliver = () =>
        gw(request(http()).post(`${route}/${id}/deliveries/wd_nope/redeliver`));
      prismaMock.webhookDelivery.findFirst.mockClear();

      for (let i = 0; i < limit; i++) {
        // An unknown delivery still spends budget: the guard counts requests,
        // not outcomes, so probing ids is bounded too.
        const res = await redeliver().expect(404);
        expect(Number(res.headers['ratelimit-limit'])).toBe(limit);
        expect(Number(res.headers['ratelimit-remaining'])).toBe(limit - 1 - i);
      }

      const refused = await redeliver().expect(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(prismaMock.webhookDelivery.findFirst).toHaveBeenCalledTimes(limit);
    });

    it('leaves the read routes unlimited', async () => {
      const res = await gw(request(http()).get(`${route}/${id}`)).expect(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    });
  });

  it('404s on a foreign/unknown id', () =>
    gw(request(http()).get(`${route}/nope`)).expect(404));

  it('deletes (200) then 404s on read', async () => {
    await gw(request(http()).delete(`${route}/${id}`)).expect(200);
    await gw(request(http()).get(`${route}/${id}`)).expect(404);
  });
});
