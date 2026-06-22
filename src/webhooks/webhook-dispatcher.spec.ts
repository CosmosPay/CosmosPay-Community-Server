import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEventPayload } from './webhook-events';
import { signPayload } from './webhook-signature';

describe('WebhookDispatcherService', () => {
  const endpoint = {
    id: 'we_1',
    url: 'https://integrator.example.com/hook',
    secret: 'whsec_test',
    enabled: true,
    eventTypes: [] as string[],
  };

  const webhookCfg = {
    maxAttempts: 3,
    backoffMs: 1,
    timeoutMs: 1000,
    signatureHeader: 'x-cosmos-signature',
  };

  function build() {
    const prisma = {
      webhookEndpoint: { findMany: jest.fn().mockResolvedValue([endpoint]) },
      webhookDelivery: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_1', attempts: 0, ...data }),
        ),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_1', ...data }),
        ),
      },
    };
    const config = { get: () => webhookCfg } as any;
    const service = new WebhookDispatcherService(prisma as any, config);
    return { service, prisma };
  }

  afterEach(() => jest.restoreAllMocks());

  it('signs the payload and delivers to subscribed endpoints (SUCCEEDED)', async () => {
    const { service, prisma } = build();
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED' as any, {
        id: 'pi_1',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(endpoint.url);

    // The signature header must be a valid HMAC of `${t}.${body}`.
    const header: string = init.headers['x-cosmos-signature'];
    const [tPart, v1Part] = header.split(',');
    const ts = Number(tPart.replace('t=', ''));
    const v1 = v1Part.replace('v1=', '');
    expect(signPayload(endpoint.secret, init.body, ts)).toBe(v1);

    // Persisted a delivery and finalized it as SUCCEEDED.
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCEEDED', responseStatus: 200 }),
      }),
    );
  });

  it('retries up to maxAttempts then marks FAILED', async () => {
    const { service, prisma } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_FAILED' as any, {
        id: 'pi_2',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(webhookCfg.maxAttempts);
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
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED' as any, {
        id: 'pi_3',
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});
