import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

const consumer = { username: 'cosmos_u1', environment: 'dev' } as never;

function build() {
  const prisma: any = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    paymentIntent: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const config = {
    get: () => ({ network: 'testnet', ttlSeconds: 3600, horizon: {} }),
  } as never;
  const service = new PaymentIntentsService(
    config,
    prisma,
    new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
    { for: () => ({ verifyByHash: jest.fn() }) } as never,
    new Sep7LinkBuilder(config, {} as never, {} as never),
    new ConsumerResolverService(prisma),
    { ensureForPayer: jest.fn() } as never,
    {} as never,
  );
  return { service, prisma };
}

describe('PaymentIntentsService.findAll', () => {
  it('keeps to the calling consumer and filters nothing else by default', async () => {
    const { service, prisma } = build();
    await service.findAll(consumer, { take: 20, skip: 0 });

    const where = prisma.paymentIntent.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ consumer: { apisixUsername: 'cosmos_u1' } });
    expect(prisma.paymentIntent.count.mock.calls[0][0].where).toEqual(where);
  });

  it('lists only intents created at or after createdFrom, in the page and in the total', async () => {
    const { service, prisma } = build();
    const from = new Date('2026-10-01T00:00:00.000Z');
    await service.findAll(consumer, {
      status: 'SUCCEEDED',
      createdFrom: from,
      take: 5,
      skip: 0,
    } as never);

    const where = prisma.paymentIntent.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      consumer: { apisixUsername: 'cosmos_u1' },
      status: 'SUCCEEDED',
      createdAt: { gte: from },
    });
    expect(prisma.paymentIntent.count.mock.calls[0][0].where).toEqual(where);
  });
});
