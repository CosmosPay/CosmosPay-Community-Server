import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { withGatewayAuth } from './gateway-auth';

/**
 * The Pollar OAuth bridge end to end, through the real guard stack.
 *
 * Prisma is a small in-memory fake and `global.fetch` is stubbed, so nothing
 * touches a database or Pollar. What is genuinely exercised is everything
 * between: the gateway gate, the scope check, the rate limiter, the handshake
 * state machine, and the shapes that go out on the wire.
 */
describe('Pollar OAuth bridge (e2e)', () => {
  let app: INestApplication;
  const handshakes = new Map<string, any>();
  const counters = new Map<string, number>();
  let seq = 0;

  /** Matches Prisma's `where` closely enough for the CAS to mean something. */
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (value && typeof value === 'object' && 'in' in value) {
        return (value.in as unknown[]).includes(row[key]);
      }
      return row[key] === value;
    });

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'c1', apisixUsername: 'cosmos_u1' }),
    },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    // The rate limiter's atomic upsert, as an in-memory counter.
    $queryRaw: jest.fn((_parts: unknown, key: string, windowStart: Date) => {
      const bucket = `${key}|${windowStart.getTime()}`;
      const next = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, next);
      return Promise.resolve([{ count: next }]);
    }),
    pollarOauthSession: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `s_${++seq}`,
          status: 'PENDING',
          redirectUri: null,
          codeChallenge: null,
          dpopJwk: null,
          deviceLabel: null,
          codeHash: null,
          codeExpiresAt: null,
          errorCode: null,
          ...data,
        };
        handshakes.set(row.id, row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...handshakes.values()].find((row) => matches(row, where)) ?? null,
        ),
      ),
      updateMany: jest.fn(({ where, data }: any) => {
        const hits = [...handshakes.values()].filter((row) =>
          matches(row, where),
        );
        for (const row of hits) Object.assign(row, data);
        return Promise.resolve({ count: hits.length });
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = [...handshakes.values()].find((r) => matches(r, where));
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
  };

  /** Queues Pollar responses in the order the bridge will ask for them. */
  function pollarReplies(...bodies: unknown[]) {
    const fetchMock = jest.spyOn(global, 'fetch');
    for (const body of bodies) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ success: true, content: body })),
      } as Response);
    }
    return fetchMock;
  }

  const LOGIN = {
    clientSessionId: 'cs_1',
    userId: 'usr_1',
    status: 'CONSUMED',
    token: {
      accessToken: 'at_1',
      refreshToken: 'rt_1',
      expiresAt: 1788350400000,
    },
    wallet: {
      type: 'internal',
      address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      existsOnStellar: true,
    },
    data: { mail: 'ada@example.com', first_name: 'Ada' },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    handshakes.clear();
    counters.clear();
  });

  describe('the guard stack', () => {
    it('refuses a request that did not come through the gateway', async () => {
      await request(app.getHttpServer())
        .post('/v1/pollar/oauth/authorize')
        .send({ provider: 'google' })
        .expect(403)
        .expect((res) => {
          expect(res.body.code).toBe('gateway_required');
        });
    });

    it('refuses a key without the pollar:write scope', async () => {
      await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        // Override the admin role the helper sets; admin bypasses scopes.
        .set('x-consumer-role', 'user')
        .set('x-consumer-permissions', 'pollar:read')
        .send({ provider: 'google' })
        .expect(403)
        .expect((res) => {
          expect(res.body.code).toBe('insufficient_scope');
        });
    });

    it('lets the callback through without any credential at all', async () => {
      // It is a browser navigation: no API key, no consumer. The unguessable
      // state is the credential.
      await request(app.getHttpServer())
        .get('/v1/pollar/oauth/callback/unknown-state')
        .expect(404)
        .expect((res) => {
          // 404 (not 403) proves it reached the handler rather than the gate.
          expect(res.body.code).toBe('not_found');
        });
    });

    it('rejects an unsupported provider before reaching Pollar', async () => {
      const fetchMock = jest.spyOn(global, 'fetch');
      await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        .send({ provider: 'facebook' })
        .expect(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('the handshake, start to finish', () => {
    it('assembles the Pollar URL and points it back at the bridge', async () => {
      pollarReplies({ clientSessionId: 'cs_1' });

      const res = await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        .send({ provider: 'google', redirect_uri: 'cosmospay://auth/cb' })
        .expect(201);

      const url = new URL(res.body.authorization_url);
      expect(url.origin + url.pathname).toBe(
        'https://sdk.api.pollar.xyz/v2/auth/google',
      );
      expect(url.searchParams.get('api_key')).toBe('pub_testnet_e2e');
      expect(url.searchParams.get('redirect_uri')).toBe(
        `https://gw.test/v1/pollar/oauth/callback/${res.body.state}`,
      );
      expect(res.body.redirect_uri).toBe('cosmospay://auth/cb');
    });

    it('refuses a redirect URI this consumer has not registered', async () => {
      const fetchMock = jest.spyOn(global, 'fetch');
      await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        .send({ provider: 'google', redirect_uri: 'https://evil.test/cb' })
        .expect(400);
      // Rejected before a Pollar session was spent on it.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('carries the code to the wallet and redeems it for a session', async () => {
      pollarReplies({ clientSessionId: 'cs_1' });
      const authorize = await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        .send({ provider: 'google', redirect_uri: 'cosmospay://auth/cb' })
        .expect(201);

      const callback = await request(app.getHttpServer())
        .get(`/v1/pollar/oauth/callback/${authorize.body.state}`)
        .expect(302);
      const delivered = new URL(callback.headers.location);
      expect(delivered.protocol).toBe('cosmospay:');
      expect(delivered.searchParams.get('state')).toBe(authorize.body.state);
      const code = delivered.searchParams.get('code')!;
      expect(code).toBeTruthy();

      pollarReplies({ status: 'READY' }, LOGIN);
      const token = await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/token'),
      )
        .send({ code })
        .expect(201);

      expect(token.body).toMatchObject({
        access_token: 'at_1',
        refresh_token: 'rt_1',
        token_type: 'Bearer',
        // The wallet is told where to go next, so it never needs us again.
        publishable_key: 'pub_testnet_e2e',
        api_base_url: 'https://sdk.api.pollar.xyz/v2',
      });
      expect(token.body.wallet.address).toBe(LOGIN.wallet.address);

      // Single use.
      pollarReplies({ status: 'READY' }, LOGIN);
      await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/token'),
      )
        .send({ code })
        .expect(400);
    });

    it('shows a codeless page when the handshake has nowhere to redirect', async () => {
      pollarReplies({ clientSessionId: 'cs_1' });
      const authorize = await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        .send({ provider: 'google' })
        .expect(201);

      const page = await request(app.getHttpServer())
        .get(`/v1/pollar/oauth/callback/${authorize.body.state}`)
        .expect(200);

      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['cache-control']).toContain('no-store');
      // The code goes over the wallet's own authenticated poll, never into a
      // browser page this service does not control.
      expect(page.text).not.toMatch(/code/i);

      const polled = await withGatewayAuth(
        request(app.getHttpServer()).get(
          `/v1/pollar/oauth/sessions/${authorize.body.state}`,
        ),
      ).expect(200);
      expect(polled.body.status).toBe('authorized');
      expect(polled.body.code).toBeTruthy();
    });
  });

  describe('the rate limit on wallet generation', () => {
    it('caps authorize and reports the budget on the way', async () => {
      // 20 per 10 minutes — the cap on how many wallets one address can cause,
      // since a handshake yields at most one.
      for (let i = 0; i < 20; i++) {
        pollarReplies({ clientSessionId: `cs_${i}` });
        const res = await withGatewayAuth(
          request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
        )
          .send({ provider: 'google' })
          .expect(201);
        expect(Number(res.headers['ratelimit-remaining'])).toBe(19 - i);
      }

      // Same spy the loop above used, so drop its history before asserting.
      const fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockClear();
      const refused = await withGatewayAuth(
        request(app.getHttpServer()).post('/v1/pollar/oauth/authorize'),
      )
        .send({ provider: 'google' })
        .expect(429);

      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      // Refused before Pollar was asked for a session — which is the whole
      // point: the spend never starts.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves an unlimited route alone', async () => {
      const res = await withGatewayAuth(
        request(app.getHttpServer()).get('/v1/pollar/oauth/sessions/nope'),
      ).expect(404);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    });
  });
});
