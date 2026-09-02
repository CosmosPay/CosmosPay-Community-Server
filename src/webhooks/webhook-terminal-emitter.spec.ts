import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  WEBHOOK_EVENT,
  WebhookEventPayload,
  terminalEventDedupKey,
} from '@/webhooks/webhook-events';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { WebhookDispatcherService } from '@/webhooks/webhook-dispatcher.service';
import { WebhookDestinationGuard } from '@/webhooks/webhook-destination.guard';

/**
 * In-memory stand-in for Postgres' unique index on `dedupKey`. Inserts on the
 * same key are serialized; the second throws P2002 — the same error Prisma
 * surfaces for a unique-constraint violation.
 */
function uniqueEmittedEventStore() {
  const rows = new Map<
    string,
    { id: string; dedupKey: string; eventType: string; createdAt: Date }
  >();
  const tails = new Map<string, Promise<unknown>>();
  let seq = 0;

  const create = async ({
    data,
  }: {
    data: { dedupKey: string; eventType: string };
  }) => {
    const prev = tails.get(data.dedupKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    tails.set(
      data.dedupKey,
      prev.then(
        () => gate,
        () => gate,
      ),
    );
    try {
      await prev.catch(() => undefined);
      if (rows.has(data.dedupKey)) {
        const err: Error & { code?: string; meta?: { target: string[] } } =
          Object.assign(
            new Error('Unique constraint failed on the fields: (`dedupKey`)'),
            {
              code: 'P2002',
              meta: { target: ['dedupKey'] },
            },
          );
        throw err;
      }
      const row = { id: `wee_${++seq}`, createdAt: new Date(), ...data };
      rows.set(data.dedupKey, row);
      return row;
    } finally {
      release();
    }
  };

  return {
    rows,
    create: jest.fn(create),
  };
}

const endpoint = {
  id: 'we_1',
  url: 'https://integrator.example.com/hook',
  secret: 'whsec_test',
  enabled: true,
  destinationBlocked: false,
  eventTypes: [] as string[],
};

function build() {
  const store = uniqueEmittedEventStore();
  const webhookDelivery = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: `wd_${++deliverySeq}`, attempts: 0, ...data }),
    ),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
  };
  const prisma: any = {
    webhookEmittedEvent: store,
    webhookEndpoint: {
      findMany: jest.fn().mockResolvedValue([endpoint]),
      update: jest.fn(),
    },
    webhookDelivery,
    /**
     * Stands in for an interactive transaction: work sees the same store, and
     * a throw undoes the rows *this* transaction inserted (not a snapshot of
     * the table — concurrent transactions must not roll each other back). The
     * atomicity is the property under test: without it a failed delivery-row
     * write leaves the claim committed and the event unnotifiable forever.
     */
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const inserted: string[] = [];
      const tx = {
        ...prisma,
        webhookEmittedEvent: {
          ...store,
          create: async (args: { data: { dedupKey: string } }) => {
            const row = await store.create(args as never);
            inserted.push(args.data.dedupKey);
            return row;
          },
        },
      };
      try {
        return await fn(tx);
      } catch (err) {
        for (const key of inserted) store.rows.delete(key);
        throw err;
      }
    },
  };
  const events = { emit: jest.fn() } as unknown as EventEmitter2;
  const dispatcher = new WebhookDispatcherService(
    prisma,
    { get: () => ({ maxAttempts: 1, backoffMs: 1 }) } as any,
    new WebhookDestinationGuard(),
  );
  const emitter = new WebhookTerminalEmitter(prisma, events, dispatcher);
  return { emitter, prisma, events, store, webhookDelivery };
}

let deliverySeq = 0;

function terminalCalls(events: EventEmitter2, type: string) {
  return (events.emit as unknown as jest.Mock).mock.calls.filter(
    ([name, payload]) => name === WEBHOOK_EVENT && payload.type === type,
  );
}

describe('WebhookTerminalEmitter (issue #29)', () => {
  it('schema and migration declare a unique index on webhook_emitted_event.dedupKey', () => {
    const schema = readFileSync(
      join(__dirname, '../../prisma/schema.prisma'),
      'utf8',
    );
    expect(schema).toMatch(
      /model WebhookEmittedEvent[\s\S]*dedupKey\s+String\s+@unique/,
    );

    const sql = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20260823040000_webhook_emitted_event/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "webhook_emitted_event_dedupKey_key" ON "webhook_emitted_event"("dedupKey")',
    );
  });

  it('builds a stable dedup key per operation, event type, and attempt', () => {
    expect(terminalEventDedupKey('SWAP_SUCCEEDED', 'swap_1')).toBe(
      'SWAP_SUCCEEDED:swap_1:0',
    );
    expect(terminalEventDedupKey('SWAP_FAILED', 'swap_1')).toBe(
      'SWAP_FAILED:swap_1:0',
    );
    expect(terminalEventDedupKey('SWAP_FAILED', 'swap_1', 1)).toBe(
      'SWAP_FAILED:swap_1:1',
    );
    expect(terminalEventDedupKey('LIQUIDITY_SUCCEEDED', 'op_1')).toBe(
      'LIQUIDITY_SUCCEEDED:op_1:0',
    );
  });

  it('emits SWAP_SUCCEEDED once; a second insert of the same key fails with P2002', async () => {
    const { emitter, events, prisma } = build();
    const data = { id: 'swap_1', status: 'SUCCEEDED' };

    const first = await emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', data);
    expect(first).toBe(true);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);

    // The case that used to pass a duplicate through: a second emit attempt
    // for the same (operation, event type). The unique index rejects it.
    await expect(
      prisma.webhookEmittedEvent.create({
        data: {
          dedupKey: terminalEventDedupKey('SWAP_SUCCEEDED', 'swap_1'),
          eventType: 'SWAP_SUCCEEDED',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['dedupKey'] } });

    const second = await emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', data);
    expect(second).toBe(false);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
  });

  it('concurrent observer-and-submit style emits produce a single bus event', async () => {
    const { emitter, events } = build();
    const data = { id: 'swap_race', status: 'SUCCEEDED' };

    // This is the case that used to fail: two paths arriving at the same
    // terminal transition each minted their own evt_ id. Now only the winner
    // of the unique insert emits.
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', data),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((won) => !won)).toHaveLength(31);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);

    const [, payload] = (events.emit as unknown as jest.Mock).mock.calls[0];
    expect(payload).toBeInstanceOf(WebhookEventPayload);
    expect(payload.consumerUsername).toBe('cosmos_u1');
    expect(payload.type).toBe('SWAP_SUCCEEDED');
    expect(payload.data).toEqual(data);
    // Integrator-facing envelope is still built by the dispatcher from this
    // payload; `deliveryIds` names rows that already exist and never reaches
    // the HTTP JSON.
    expect(Object.keys(payload)).toEqual([
      'consumerUsername',
      'type',
      'data',
      'deliveryIds',
    ]);
    expect(payload.deliveryIds).toEqual([expect.stringMatching(/^wd_/)]);
  });

  it('commits the delivery rows with the claim, before touching the bus', async () => {
    const { emitter, events, store, webhookDelivery } = build();

    const order: string[] = [];
    webhookDelivery.create.mockImplementationOnce(
      ({ data }: { data: Record<string, unknown> }) => {
        order.push('delivery-row');
        return Promise.resolve({ id: 'wd_ordered', attempts: 0, ...data });
      },
    );
    (events.emit as unknown as jest.Mock).mockImplementation(() => {
      order.push('bus');
      return true;
    });

    await expect(
      emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_order' }),
    ).resolves.toBe(true);

    // The durable work exists before anything in memory is relied on: a crash
    // after the emit leaves a row the sweeper can finish, not a burned claim.
    expect(order).toEqual(['delivery-row', 'bus']);
    expect(store.rows.has('SWAP_SUCCEEDED:swap_order:0')).toBe(true);
    const [, payload] = (events.emit as unknown as jest.Mock).mock.calls[0];
    expect(payload.deliveryIds).toEqual(['wd_ordered']);
  });

  it('rolls the claim back when the delivery rows cannot be written', async () => {
    const { emitter, events, store, webhookDelivery } = build();
    webhookDelivery.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_rollback' }),
    ).rejects.toThrow('db down');

    // This is the failure that used to be permanent: the claim was committed
    // on its own, so no later path could ever notify. Now nothing is claimed
    // and the retry wins it.
    expect(store.rows.has('SWAP_SUCCEEDED:swap_rollback:0')).toBe(false);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(0);

    await expect(
      emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_rollback' }),
    ).resolves.toBe(true);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
  });

  it('does not claim a unique row for non-terminal events', async () => {
    const { emitter, events, prisma } = build();
    const created = await emitter.emit('cosmos_u1', 'SWAP_CREATED', {
      id: 'swap_1',
    });
    expect(created).toBe(true);
    expect(prisma.webhookEmittedEvent.create).not.toHaveBeenCalled();
    expect(terminalCalls(events, 'SWAP_CREATED')).toHaveLength(1);
  });

  it('allows SUCCEEDED and FAILED claims on the same operation (different keys)', async () => {
    const { emitter, events } = build();
    await expect(
      emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_1' }),
    ).resolves.toBe(true);
    await expect(
      emitter.emit('cosmos_u1', 'SWAP_FAILED', { id: 'swap_1' }),
    ).resolves.toBe(true);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
    expect(terminalCalls(events, 'SWAP_FAILED')).toHaveLength(1);
  });

  it('emits SWAP_FAILED again after a later settlement epoch (resubmit)', async () => {
    const { emitter, events } = build();
    await expect(
      emitter.emit('cosmos_u1', 'SWAP_FAILED', {
        id: 'swap_1',
        settlementEpoch: 0,
      }),
    ).resolves.toBe(true);
    await expect(
      emitter.emit('cosmos_u1', 'SWAP_FAILED', {
        id: 'swap_1',
        settlementEpoch: 1,
      }),
    ).resolves.toBe(true);
    expect(terminalCalls(events, 'SWAP_FAILED')).toHaveLength(2);
  });

  it('dedupes SWAP_FAILED at the same settlement epoch', async () => {
    const { emitter, events } = build();
    const data = { id: 'swap_1', settlementEpoch: 0 };
    const results = await Promise.all([
      emitter.emit('cosmos_u1', 'SWAP_FAILED', data),
      emitter.emit('cosmos_u1', 'SWAP_FAILED', data),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(terminalCalls(events, 'SWAP_FAILED')).toHaveLength(1);
  });
});
