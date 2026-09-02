import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

jest.mock('node:https', () => ({
  __esModule: true,
  request: jest.fn(),
}));

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { request as httpsRequest } from 'node:https';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEventPayload } from './webhook-events';
import { signPayload } from './webhook-signature';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { WebhookHttpClient } from './webhook-http';

describe('WebhookDispatcherService', () => {
  const endpoint = {
    id: 'we_1',
    url: 'https://integrator.example.com/hook',
    secret: 'whsec_test',
    enabled: true,
    destinationBlocked: false,
    eventTypes: [] as string[],
  };

  const webhookCfg = {
    maxAttempts: 3,
    backoffMs: 1,
    timeoutMs: 1000,
    connectTimeoutMs: 500,
    readTimeoutMs: 1000,
    maxResponseBytes: 1024,
    signatureHeader: 'x-cosmos-signature',
  };

  type RequestCall = { options: any; body: string };

  /**
   * Replaces `https.request`, recording what the transport was asked to do.
   * Nothing may reach the network: the property under test is precisely that a
   * socket is only ever opened to an address the guard validated.
   */
  function stubHttps(status: number | Error = 200): RequestCall[] {
    const calls: RequestCall[] = [];
    (httpsRequest as unknown as jest.Mock).mockImplementation(
      (options: any, callback: (res: any) => void) => {
        const req = new EventEmitter() as EventEmitter & {
          end: (body: string) => void;
        };
        req.end = (body: string) => {
          calls.push({ options, body });
          setImmediate(() => {
            if (status instanceof Error) {
              req.emit('error', status);
              return;
            }
            const incoming = Readable.from([]) as Readable & {
              statusCode?: number;
            };
            incoming.statusCode = status;
            callback(incoming);
          });
        };
        return req;
      },
    );
    return calls;
  }

  function build(destinations?: WebhookDestinationGuard) {
    const prisma = {
      webhookEndpoint: {
        findMany: jest.fn().mockResolvedValue([endpoint]),
        findUnique: jest.fn().mockResolvedValue(endpoint),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ ...endpoint, ...data }),
        ),
      },
      webhookDelivery: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_1', attempts: 0, ...data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_1', ...data }),
        ),
      },
    };
    const config = { get: () => webhookCfg } as any;
    const guard = destinations ?? new WebhookDestinationGuard();
    if (!destinations) {
      guard.replaceDnsLookup(async () => ['93.184.216.34']);
    }
    const service = new WebhookDispatcherService(prisma as any, config, guard);
    return { service, prisma, guard };
  }

  beforeEach(() => (httpsRequest as unknown as jest.Mock).mockReset());
  afterEach(() => jest.restoreAllMocks());

  it('signs the payload and delivers to subscribed endpoints (SUCCEEDED)', async () => {
    const { service, prisma } = build();
    const calls = stubHttps(200);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_1',
      }),
    );

    expect(calls).toHaveLength(1);
    const { options, body } = calls[0];
    expect(options.host).toBe('integrator.example.com');
    expect(options.path).toBe('/hook');

    // The signature header must be a valid HMAC of `${t}.${body}`.
    const header: string = options.headers['x-cosmos-signature'];
    const [tPart, v1Part] = header.split(',');
    const ts = Number(tPart.replace('t=', ''));
    const v1 = v1Part.replace('v1=', '');
    expect(signPayload(endpoint.secret, body, ts)).toBe(v1);

    // Integrator HTTP envelope is unchanged: { id, type, createdAt, data }.
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(['id', 'type', 'createdAt', 'data']);
    expect(parsed.id).toMatch(/^evt_/);
    expect(parsed.type).toBe('PAYMENT_INTENT_CREATED');
    expect(parsed.data).toEqual({ id: 'pi_1' });
    expect(options.headers['x-cosmos-event']).toBe('PAYMENT_INTENT_CREATED');
    expect(options.headers['x-cosmos-delivery']).toBe('wd_1');

    // Persisted a delivery and finalized it as SUCCEEDED.
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          responseStatus: 200,
        }),
      }),
    );
  });

  it('connects to the address the guard validated, not to a fresh resolution', async () => {
    const guard = new WebhookDestinationGuard();
    let lookups = 0;
    guard.replaceDnsLookup(async () => {
      lookups += 1;
      return ['93.184.216.34'];
    });
    const { service } = build(guard);
    const calls = stubHttps(200);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_pin',
      }),
    );

    // Exactly one resolution happened — the validator's. The socket cannot run
    // its own: it is handed a `lookup` that answers with the checked address,
    // which is what closes the rebinding window between check and connect.
    expect(lookups).toBe(1);
    const pinned = jest.fn();
    calls[0].options.lookup('integrator.example.com', {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('retries up to maxAttempts then marks FAILED', async () => {
    const { service, prisma } = build();
    const calls = stubHttps(500);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_FAILED', {
        id: 'pi_2',
      }),
    );

    expect(calls).toHaveLength(webhookCfg.maxAttempts);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', attempts: 3 }),
      }),
    );
  });

  it('skips endpoints not subscribed to the event type', async () => {
    const { service, prisma } = build();
    prisma.webhookEndpoint.findMany.mockResolvedValueOnce([
      { ...endpoint, eventTypes: ['PAYMENT_INTENT_SUCCEEDED'] },
    ]);
    const calls = stubHttps(200);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_3',
      }),
    );

    expect(calls).toHaveLength(0);
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('revalidates DNS before delivery and does not connect when DNS flips to private', async () => {
    const guard = new WebhookDestinationGuard();
    let lookups = 0;
    guard.replaceDnsLookup(async () => {
      lookups += 1;
      // First call simulates a safe register-time resolution; delivery sees private.
      return lookups === 1 ? ['93.184.216.34'] : ['10.0.0.8'];
    });

    // Register-time check would pass, pinned to the public answer:
    await expect(
      guard.assertSafe('https://integrator.example.com/hook'),
    ).resolves.toMatchObject({
      hostname: 'integrator.example.com',
      address: '93.184.216.34',
      family: 4,
      port: 443,
    });

    const { service, prisma } = build(guard);
    const calls = stubHttps(200);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_dns_flip',
      }),
    );

    expect(calls).toHaveLength(0);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringMatching(/private/i),
        }),
      }),
    );
    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destinationBlocked: true,
          enabled: false,
        }),
      }),
    );
  });

  it('does not follow redirects: a 3xx is a failed delivery', async () => {
    const { service, prisma } = build();
    const calls = stubHttps(302);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_redirect',
      }),
    );

    // Every attempt went to the registered host; nothing chased a Location.
    expect(new Set(calls.map((c) => c.options.host))).toEqual(
      new Set(['integrator.example.com']),
    );
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: 'Non-2xx response: 302',
        }),
      }),
    );
  });

  it('delivers rows the emitter already persisted instead of creating new ones', async () => {
    const { service, prisma } = build();
    const calls = stubHttps(200);
    prisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'wd_persisted',
        endpointId: endpoint.id,
        eventType: 'SWAP_SUCCEEDED',
        eventId: 'evt_persisted',
        payload: { id: 'evt_persisted', type: 'SWAP_SUCCEEDED', data: {} },
        attempts: 0,
        endpoint,
      },
    ]);

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_1' }, [
        'wd_persisted',
      ]),
    );

    // The claim transaction already wrote the row; re-creating it here would
    // send the settlement twice after a sweep recovery.
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['wd_persisted'] } },
      include: { endpoint: true },
    });
    expect(calls[0].options.headers['x-cosmos-delivery']).toBe('wd_persisted');
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wd_persisted' },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
  });

  it('persistDeliveries writes through the caller transaction when given one', async () => {
    const { service, prisma } = build();
    const tx = {
      webhookEndpoint: { findMany: jest.fn().mockResolvedValue([endpoint]) },
      webhookDelivery: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_tx', attempts: 0, ...data }),
        ),
      },
    };

    const pending = await service.persistDeliveries(
      new WebhookEventPayload('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_1' }),
      tx as any,
    );

    expect(pending).toHaveLength(1);
    expect(pending[0].delivery.id).toBe('wd_tx');
    expect(tx.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    // Nothing leaked onto the client connection, which would commit early.
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('sends through the injected HTTP client, so tests can replace the network', async () => {
    const { prisma, guard } = build();
    stubHttps(200);
    const http = {
      send: jest.fn().mockResolvedValue({ status: 202, ok: true }),
    };
    const service = new WebhookDispatcherService(
      prisma as any,
      { get: () => webhookCfg } as any,
      guard,
      http,
    );

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_seam',
      }),
    );

    // Nothing reached the transport: overriding the provider (or spying on the
    // resolved instance) is enough to keep a booted app off the network.
    expect(httpsRequest as unknown as jest.Mock).not.toHaveBeenCalled();
    expect(http.send).toHaveBeenCalledWith(
      expect.objectContaining({
        url: endpoint.url,
        destination: expect.objectContaining({ address: '93.184.216.34' }),
      }),
    );
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          responseStatus: 202,
        }),
      }),
    );
  });

  it('takes the transport from DI, so overrideProvider keeps a booted app off the network', async () => {
    const { prisma, guard } = build();
    stubHttps(200);
    const http = {
      send: jest.fn().mockResolvedValue({ status: 200, ok: true }),
    };

    // Exactly what an e2e suite does: override the provider, boot, no sockets.
    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        WebhookDestinationGuard,
        WebhookHttpClient,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => webhookCfg } },
      ],
    })
      .overrideProvider(WebhookDestinationGuard)
      .useValue(guard)
      .overrideProvider(WebhookHttpClient)
      .useValue(http)
      .compile();

    await moduleRef.get(WebhookDispatcherService).pingEndpoint(endpoint as any);

    expect(http.send).toHaveBeenCalledTimes(1);
    expect(httpsRequest as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  describe('pingEndpoint', () => {
    it('goes through the same pinned, signed path as a delivery', async () => {
      const { service, prisma } = build();
      const calls = stubHttps(200);

      await expect(service.pingEndpoint(endpoint as any)).resolves.toEqual({
        ok: true,
        responseStatus: 200,
        error: null,
      });

      const { options, body } = calls[0];
      expect(options.host).toBe('integrator.example.com');
      expect(typeof options.lookup).toBe('function');
      expect(options.headers['x-cosmos-event']).toBe('ping');
      const [tPart, v1Part] = options.headers['x-cosmos-signature'].split(',');
      expect(
        signPayload(endpoint.secret, body, Number(tPart.replace('t=', ''))),
      ).toBe(v1Part.replace('v1=', ''));
      // A ping is not a delivery: nothing is persisted.
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });

    it('blocks the endpoint when the destination is no longer safe', async () => {
      const guard = new WebhookDestinationGuard();
      guard.replaceDnsLookup(async () => ['169.254.169.254']);
      const { service, prisma } = build(guard);
      const calls = stubHttps(200);

      const result = await service.pingEndpoint(endpoint as any);

      expect(calls).toHaveLength(0);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/link-local|cloud-metadata/i);
      expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ destinationBlocked: true }),
        }),
      );
    });
  });
});
