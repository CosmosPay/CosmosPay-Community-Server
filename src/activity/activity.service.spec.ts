import type { Request } from 'express';
import { ActivityService } from '@/activity/activity.service';
import {
  ACTIVITY_MESSAGE_MAX,
  ACTIVITY_PROPS_MAX_BYTES,
  ACTIVITY_PROPS_OVERSIZED,
} from '@/activity/activity.constants';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

/**
 * What is worth pinning here is the ingest contract, not the queries:
 *
 *   - attribution comes from the gateway, never from the body;
 *   - a malformed field costs that field, never the batch;
 *   - a wrong device clock cannot file an event in the future.
 *
 * Each of those is a decision a later "simplification" could quietly reverse
 * while every type still checks.
 */
describe('ActivityService', () => {
  const consumer: GatewayConsumer = {
    username: 'cosmos_u1',
    credentialId: 'cosmos_c1',
    environment: 'dev',
    role: 'user',
    permissions: ['activity:write'],
    organizationId: null,
    plan: null,
    planSwapFeeBps: null,
  };

  // Only the two fields ingest reads; the rest of an express Request is not
  // reachable from here and constructing one would test the fixture, not this.
  const request = {
    ip: '203.0.113.7',
    headers: { 'user-agent': 'CosmosWallet/1.5.0' },
  } as unknown as Request;

  function build() {
    const prisma = {
      activityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const consumers = {
      resolve: jest.fn().mockResolvedValue({ id: 'local_1' }),
    };
    const service = new ActivityService(prisma as any, consumers as any);
    return { service, prisma, consumers };
  }

  const rowsOf = (prisma: { activityEvent: { createMany: jest.Mock } }) =>
    prisma.activityEvent.createMany.mock.calls[0][0].data as Record<
      string,
      unknown
    >[];

  it('writes under the gateway consumer, whatever the body says', async () => {
    const { service, prisma, consumers } = build();

    await service.ingest(
      consumer,
      {
        events: [
          {
            type: 'payment.sent',
            // A client trying to file its event against someone else. There is
            // no field for it, and this asserts none is ever quietly added.
            ...({ consumerId: 'local_victim' } as object),
          },
        ],
      },
      request,
    );

    expect(consumers.resolve).toHaveBeenCalledWith(consumer);
    expect(rowsOf(prisma)[0].consumerId).toBe('local_1');
  });

  it('applies the defaults a minimal event omits', async () => {
    const { service, prisma } = build();

    await service.ingest(consumer, { events: [{ type: 'app.open' }] }, request);

    const row = rowsOf(prisma)[0];
    expect(row.source).toBe('sdk');
    expect(row.level).toBe('info');
    expect(row.category).toBe('event');
    expect(row.ip).toBe('203.0.113.7');
    expect(row.userAgent).toBe('CosmosWallet/1.5.0');
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  it('truncates an over-long message instead of failing the batch', async () => {
    const { service, prisma } = build();

    await service.ingest(
      consumer,
      { events: [{ type: 'crash', message: 'x'.repeat(5_000) }] },
      request,
    );

    expect((rowsOf(prisma)[0].message as string).length).toBe(
      ACTIVITY_MESSAGE_MAX,
    );
  });

  it('replaces over-sized props with a marker, keeping the event', async () => {
    const { service, prisma } = build();

    await service.ingest(
      consumer,
      {
        events: [
          {
            type: 'swap.failed',
            props: { blob: 'y'.repeat(ACTIVITY_PROPS_MAX_BYTES + 1) },
          },
        ],
      },
      request,
    );

    const row = rowsOf(prisma)[0];
    expect(row.type).toBe('swap.failed');
    expect(row.props).toEqual(ACTIVITY_PROPS_OVERSIZED);
  });

  it('keeps props that fit', async () => {
    const { service, prisma } = build();

    await service.ingest(
      consumer,
      { events: [{ type: 'payment.sent', props: { asset: 'XLM' } }] },
      request,
    );

    expect(rowsOf(prisma)[0].props).toEqual({ asset: 'XLM' });
  });

  it('clamps a device clock that runs ahead', async () => {
    const { service, prisma } = build();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await service.ingest(
      consumer,
      { events: [{ type: 'app.open', occurredAt: future }] },
      request,
    );

    // Clamped to receipt time — otherwise a newest-first list pins it to the top
    // for as long as the row is kept.
    expect((rowsOf(prisma)[0].occurredAt as Date).getTime()).toBeLessThan(
      Date.parse(future),
    );
  });

  it('keeps a plausible backfilled timestamp from an offline flush', async () => {
    const { service, prisma } = build();
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await service.ingest(
      consumer,
      { events: [{ type: 'payment.sent', occurredAt: earlier }] },
      request,
    );

    expect((rowsOf(prisma)[0].occurredAt as Date).toISOString()).toBe(earlier);
  });

  it('reports duplicates rather than treating a retried flush as an error', async () => {
    const { service, prisma } = build();
    prisma.activityEvent.createMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.ingest(
      consumer,
      {
        events: [
          { type: 'app.open', eventId: 'e1' },
          { type: 'app.open', eventId: 'e2' },
        ],
      },
      request,
    );

    expect(prisma.activityEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(result).toEqual({ accepted: 1, duplicates: 1 });
  });
});
