import { ApiError } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

/**
 * One intent by its id is reached only through the network the key targets, as the
 * list is. The fake below answers a `where` the way Postgres would (every field it
 * names must match), so a lookup that leaves the network out finds the other
 * network's row, and the test fails, exactly as the real query did.
 */
const OWNER = 'cosmos_u1';
const MAINNET_ID = 'pi_mainnet';

const sandboxKey = { username: OWNER, environment: 'dev' } as never;
const productionKey = { username: OWNER, environment: 'prod' } as never;

function build() {
  const rows = new Map<string, any>([
    [
      MAINNET_ID,
      {
        id: MAINNET_ID,
        consumerId: 'c1',
        network: 'public',
        chain: 'stellar',
        kind: 'PAY',
        status: 'PENDING',
        memo: '123',
        uri: 'web+stellar:pay?destination=G',
        reference: 'live',
        txHash: null,
      },
    ],
  ]);
  const usernameOf: Record<string, string> = { c1: OWNER };
  const matches = (row: any, where: any) =>
    (where.id === undefined || row.id === where.id) &&
    (where.network === undefined || row.network === where.network) &&
    (where.status === undefined || row.status === where.status) &&
    (where.consumer?.apisixUsername === undefined ||
      usernameOf[row.consumerId] === where.consumer.apisixUsername);

  const prisma: any = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    paymentIntent: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...rows.values()].find((r) => matches(r, where)) ?? null,
        ),
      ),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(({ where }: any) => {
        const hit = [...rows.values()].filter((r) => matches(r, where));
        hit.forEach((r) => rows.delete(r.id));
        return Promise.resolve({ count: hit.length });
      }),
    },
    paymentIntentTransition: { findMany: jest.fn().mockResolvedValue([]) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const verifyByHash = jest.fn();
  const config = {
    get: () => ({ network: 'testnet', ttlSeconds: 3600, horizon: {} }),
  } as never;
  const service = new PaymentIntentsService(
    config,
    prisma,
    new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
    { for: () => ({ verifyByHash }) } as never,
    new Sep7LinkBuilder(config, {} as never, {} as never),
    new ConsumerResolverService(prisma),
    { ensureForPayer: jest.fn() } as never,
    {} as never,
  );
  return { service, prisma, rows, verifyByHash };
}

async function notFound(call: Promise<unknown>) {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).getStatus()).toBe(404);
}

describe('PaymentIntentsService: one intent by its id, on the key network only', () => {
  it('scopes every by-id lookup to the consumer AND the key network', async () => {
    const { service, prisma } = build();
    await service.findOne(productionKey, MAINNET_ID);
    expect(prisma.paymentIntent.findFirst.mock.calls[0][0].where).toEqual({
      id: MAINNET_ID,
      consumer: { apisixUsername: OWNER },
      network: 'public',
    });
  });

  it("answers a sandbox key the 404 of a missing intent for the account's mainnet intent", async () => {
    const { service } = build();
    await notFound(service.findOne(sandboxKey, MAINNET_ID));
    await notFound(service.listTransitions(sandboxKey, MAINNET_ID));
  });

  it('lets a sandbox key neither change, validate nor delete a mainnet intent', async () => {
    const { service, prisma, rows, verifyByHash } = build();

    await notFound(
      service.update(sandboxKey, MAINNET_ID, { reference: 'sandbox' }),
    );
    await notFound(
      service.update(sandboxKey, MAINNET_ID, { status: 'CANCELLED' } as never),
    );
    await notFound(service.validate(sandboxKey, MAINNET_ID, 'd'.repeat(64)));
    await notFound(service.remove(sandboxKey, MAINNET_ID));

    expect(prisma.paymentIntent.update).not.toHaveBeenCalled();
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
    expect(verifyByHash).not.toHaveBeenCalled();
    expect(rows.get(MAINNET_ID)).toMatchObject({
      status: 'PENDING',
      reference: 'live',
    });
  });

  it('still serves the production key that owns it', async () => {
    const { service, rows } = build();
    const intent = await service.findOne(productionKey, MAINNET_ID);
    expect(intent.id).toBe(MAINNET_ID);

    await expect(service.remove(productionKey, MAINNET_ID)).resolves.toEqual({
      id: MAINNET_ID,
      deleted: true,
    });
    expect(rows.has(MAINNET_ID)).toBe(false);
  });
});
