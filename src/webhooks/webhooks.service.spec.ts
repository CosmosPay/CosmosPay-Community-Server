import { ConsumerResolverService } from '../common/services/consumer-resolver.service';
import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '../common/errors/api-error';
import { WebhooksService } from './webhooks.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';

describe('WebhooksService destination validation', () => {
  const consumer = {
    username: 'cosmos_u1',
    credentialId: 'cred_1',
  } as any;

  function build() {
    const prisma = {
      consumer: {
        upsert: jest.fn().mockResolvedValue({ id: 'c1' }),
      },
      webhookEndpoint: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({
            id: 'we_new',
            secret: 'whsec_x',
            enabled: true,
            destinationBlocked: false,
            eventTypes: [],
            description: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            consumerId: 'c1',
            ...data,
          }),
        ),
      },
    };
    const guard = new WebhookDestinationGuard();
    const dispatcher = {} as any;
    const service = new WebhooksService(
      prisma as any,
      dispatcher,
      guard,
      new ConsumerResolverService(prisma as never),
    );
    return { service, prisma, guard };
  }

  it('rejects registering a loopback endpoint with a coded 400', async () => {
    const { service, prisma } = build();

    const err = await service
      .create(consumer, { url: 'https://127.0.0.1/hooks' } as any)
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err!.code).toBe(ApiErrorCode.ValidationFailed);

    expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it('rejects private, link-local and metadata destinations at register', async () => {
    const { service } = build();

    await expect(
      service.create(consumer, { url: 'https://10.0.0.1/h' } as any),
    ).rejects.toThrow(/private/i);

    await expect(
      service.create(consumer, { url: 'https://169.254.1.1/h' } as any),
    ).rejects.toThrow(/link-local|cloud-metadata/i);

    await expect(
      service.create(consumer, {
        url: 'https://169.254.169.254/latest/meta-data',
      } as any),
    ).rejects.toThrow(/link-local|cloud-metadata/i);

    await expect(
      service.create(consumer, {
        url: 'http://integrator.example.com/h',
      } as any),
    ).rejects.toThrow(/https scheme/i);
  });

  it('allows a public https destination', async () => {
    const { service, prisma, guard } = build();
    guard.replaceDnsLookup(async () => ['93.184.216.34']);

    const created = await service.create(consumer, {
      url: 'https://integrator.example.com/hooks',
    });

    expect(created.url).toBe('https://integrator.example.com/hooks');
    expect(prisma.webhookEndpoint.create).toHaveBeenCalled();
  });
});

/**
 * A `RECEIVER_UPDATED` delivery body is the BlindPay object verbatim — the
 * complete KYC dossier. These routes are gated on `webhooks:read`, a weaker
 * scope than `kyc:read`, so the body must never be readable back through them.
 */
describe('WebhooksService delivery bodies are never returned', () => {
  const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;

  const DOSSIER = {
    id: 'evt_1',
    type: 'RECEIVER_UPDATED',
    data: {
      id: 'rc_1',
      tax_id: '20-12345678-9',
      address_line_1: 'Av. Siempre Viva 742',
      id_doc_front_file: 'https://files.blindpay.test/front.png',
    },
  };

  function build() {
    const delivery = {
      id: 'wd_1',
      endpointId: 'we_1',
      eventType: 'RECEIVER_UPDATED',
      eventId: 'evt_1',
      payload: DOSSIER,
      status: 'SUCCEEDED',
      attempts: 1,
      responseStatus: 200,
      error: null,
      lastAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const findMany = jest.fn(({ omit }: any) =>
      Promise.resolve([
        omit?.payload
          ? (({ payload: _drop, ...rest }) => rest)(delivery)
          : delivery,
      ]),
    );
    const prisma = {
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
      webhookEndpoint: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'we_1', url: 'https://x' }),
      },
      webhookDelivery: {
        findMany,
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue(delivery),
      },
    };
    const dispatcher = { redeliver: jest.fn().mockResolvedValue(delivery) };
    const service = new WebhooksService(
      prisma as any,
      dispatcher as any,
      new WebhookDestinationGuard(),
      new ConsumerResolverService(prisma as never),
    );
    return { service, prisma, dispatcher, findMany };
  }

  it('omits the sent body from the delivery log', async () => {
    const { service, findMany } = build();

    const page = await service.listDeliveries(consumer, 'we_1', {
      take: 20,
      skip: 0,
    });

    // Not fetched at all, so it cannot leak through a later serialization.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ omit: { payload: true } }),
    );
    expect(page.data[0]).not.toHaveProperty('payload');
    // Everything an integrator actually needs from the log is still there.
    expect(page.data[0]).toMatchObject({
      id: 'wd_1',
      eventType: 'RECEIVER_UPDATED',
      status: 'SUCCEEDED',
      responseStatus: 200,
    });
    expect(JSON.stringify(page)).not.toContain('20-12345678-9');
  });

  it('omits the sent body from a redelivery response', async () => {
    const { service, dispatcher } = build();

    const result = await service.redeliver(consumer, 'we_1', 'wd_1');

    // The dispatcher still gets the body — a retry has to re-send exactly what
    // was signed — it just does not reach the caller.
    expect(dispatcher.redeliver).toHaveBeenCalledWith(
      expect.objectContaining({ payload: DOSSIER }),
    );
    expect(result).not.toHaveProperty('payload');
    expect(JSON.stringify(result)).not.toContain('Av. Siempre Viva');
  });
});
