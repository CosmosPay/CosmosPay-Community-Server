import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WEBHOOK_EVENT, WebhookEventPayload } from '@/webhooks/webhook-events';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';

/**
 * A payment intent that settles must not be able to notify nobody.
 *
 * The failure this guards: the status transition commits, the process is killed
 * (OOM, rolling deploy) before the in-memory bus listener writes anything, and
 * because nothing durable was ever recorded there is no row for the delivery
 * sweeper to retry — the integrator never hears that the payment landed.
 * Routing PAYMENT_INTENT_SUCCEEDED / _FAILED through `WebhookTerminalEmitter`
 * puts the `webhook_delivery` rows on disk, in one transaction with the dedup
 * claim, *before* the event reaches the bus.
 */
describe('payment intent terminal webhooks are durable', () => {
  const intentBase = {
    id: 'pi_1',
    consumerId: 'c1',
    kind: 'TX',
    source: 'GSRC',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123',
    network: 'testnet',
    status: 'PENDING' as string,
    xdr: 'xdr',
    uri: 'web+stellar:tx?xdr=xdr',
    txHash: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /** The writes one transaction flushed, in order. */
  type Commit = string[];

  let row: typeof intentBase;
  let commits: Commit[];
  /** Commits and bus emits interleaved, so ordering can be asserted. */
  let timeline: string[];
  let prisma: any;
  let events: EventEmitter2;
  let dispatcher: { persistDeliveries: jest.Mock };
  let service: PaymentIntentsService;

  const claimed = () =>
    commits.some((c) => c.includes('webhookEmittedEvent.create'));

  beforeEach(() => {
    row = { ...intentBase };
    commits = [];
    timeline = [];

    const store: any = {
      paymentIntent: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === row.id ? { ...row } : null,
        ),
        findUniqueOrThrow: jest.fn(async () => ({ ...row })),
        findFirst: jest.fn(async () => ({ ...row })),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.id !== row.id || where.status !== row.status) {
            return { count: 0 };
          }
          row = { ...row, ...data };
          return { count: 1 };
        }),
      },
      paymentIntentTransition: { create: jest.fn(async () => ({})) },
      webhookEmittedEvent: { create: jest.fn(async () => ({})) },
      webhookDelivery: {
        create: jest.fn(async ({ data }: any) => ({
          id: `whd_${data.endpointId}`,
          ...data,
        })),
      },
      webhookEndpoint: {
        findMany: jest.fn(async () => [{ id: 'ep_1', eventTypes: [] }]),
      },
      customer: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    /**
     * Hands the callback a writer distinct from the client, and records each
     * write against the transaction that issued it. A write that bypassed the
     * transaction — or one whose transaction threw — is visibly absent from
     * `commits`, which is the property these tests turn on.
     */
    const txWriter = (pending: Commit) => {
      const wrapModel = (model: string, target: any) =>
        new Proxy(target, {
          get: (t, prop: string) =>
            typeof t[prop] === 'function'
              ? async (...args: unknown[]) => {
                  if (!prop.startsWith('find'))
                    pending.push(`${model}.${prop}`);
                  return t[prop](...args);
                }
              : t[prop],
        });
      return new Proxy(store, {
        get: (t: any, prop: string) =>
          t[prop] && typeof t[prop] === 'object'
            ? wrapModel(prop, t[prop])
            : t[prop],
      });
    };

    prisma = new Proxy(store, {
      get: (target: any, prop: string) => {
        if (prop !== '$transaction') return target[prop];
        return async (fn: any) => {
          if (typeof fn !== 'function') return Promise.all(fn);
          const pending: Commit = [];
          const result = await fn(txWriter(pending));
          // Only a resolved callback commits.
          commits.push(pending);
          timeline.push(...pending.map((w) => `commit:${w}`));
          return result;
        };
      },
    });

    events = {
      emit: jest.fn(() => {
        timeline.push('bus:emit');
        return true;
      }),
    } as any;

    dispatcher = {
      // Mirrors the real dispatcher: one PENDING delivery row per subscribed
      // endpoint, written through whatever writer it is handed — the emitter's
      // transaction here.
      persistDeliveries: jest.fn(
        async (payload: WebhookEventPayload, writer: any = prisma) => {
          const endpoints = await writer.webhookEndpoint.findMany({});
          const out: unknown[] = [];
          for (const endpoint of endpoints) {
            out.push({
              endpoint,
              delivery: await writer.webhookDelivery.create({
                data: { endpointId: endpoint.id, eventType: payload.type },
              }),
            });
          }
          return out;
        },
      ),
    };

    const config = { get: () => ({ network: 'testnet', ttlSeconds: 3600 }) };
    service = new PaymentIntentsService(
      config as any,
      prisma,
      new WebhookTerminalEmitter(prisma, events, dispatcher as any),
      {} as any,
      {} as any,
      new ConsumerResolverService(prisma as never),
    );
  });

  const settle = () =>
    service.transition(row.id, 'SUCCEEDED', {
      consumerUsername: 'cosmos_u1',
      actor: 'validate',
      txHash: 'a'.repeat(64),
    });

  it('writes the delivery row in the same transaction as the dedup claim', async () => {
    await settle();

    const claimCommit = commits.find((c) =>
      c.includes('webhookEmittedEvent.create'),
    );
    expect(claimCommit).toBeDefined();
    // The same commit, not merely both present: the claim can never outlive the
    // durable work it authorizes.
    expect(claimCommit).toContain('webhookDelivery.create');
    expect(dispatcher.persistDeliveries).toHaveBeenCalledTimes(1);
  });

  it('commits the delivery row before the event reaches the in-memory bus', async () => {
    await settle();

    const delivery = timeline.indexOf('commit:webhookDelivery.create');
    const bus = timeline.indexOf('bus:emit');
    expect(delivery).toBeGreaterThanOrEqual(0);
    expect(bus).toBeGreaterThanOrEqual(0);
    // A crash anywhere past this point still leaves work the sweeper can finish.
    expect(delivery).toBeLessThan(bus);
  });

  it('emits PAYMENT_INTENT_SUCCEEDED carrying the ids it just persisted', async () => {
    await settle();

    const call = (events.emit as jest.Mock).mock.calls.find(
      ([name]) => name === WEBHOOK_EVENT,
    );
    expect(call).toBeDefined();
    const payload = call![1] as WebhookEventPayload;
    expect(payload.type).toBe('PAYMENT_INTENT_SUCCEEDED');
    // The dispatcher must send exactly these rows and create no more, or an
    // event recovered after a crash would go out twice.
    expect(payload.deliveryIds).toEqual(['whd_ep_1']);
  });

  it('does not reach the bus when the delivery rows cannot be written', async () => {
    dispatcher.persistDeliveries.mockRejectedValueOnce(
      new Error('endpoint table unavailable'),
    );

    await expect(settle()).rejects.toThrow('endpoint table unavailable');

    // The claim rolled back with its transaction, so a later path can still win
    // it — strictly better than a burnt claim with nothing on disk behind it.
    expect(claimed()).toBe(false);
    expect(timeline).not.toContain('bus:emit');
  });

  it('settles the intent in its own transaction, before any webhook work', async () => {
    await settle();

    const transitionAt = commits.findIndex((c) =>
      c.includes('paymentIntentTransition.create'),
    );
    const claimAt = commits.findIndex((c) =>
      c.includes('webhookEmittedEvent.create'),
    );
    expect(transitionAt).toBeGreaterThanOrEqual(0);
    expect(commits[transitionAt]).toContain('paymentIntent.updateMany');
    // Two separate commits: the intent is durably SUCCEEDED first. The residual
    // crash window is between them, and it is the same one swaps have.
    expect(claimAt).toBeGreaterThan(transitionAt);
  });

  it('sends non-terminal events straight to the bus with no claim', async () => {
    await service.transition(row.id, 'SUBMITTED', {
      consumerUsername: 'cosmos_u1',
      actor: 'api',
    });

    expect(timeline).toContain('bus:emit');
    expect(claimed()).toBe(false);
    expect(dispatcher.persistDeliveries).not.toHaveBeenCalled();
  });
});
