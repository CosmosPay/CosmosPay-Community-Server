import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdvisoryLockService } from '@/common/services/advisory-lock.service';
import type { PrismaService } from '@/prisma/prisma.service';
import { WEBHOOK_EVENT, WebhookEventPayload } from '@/webhooks/webhook-events';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import type { BlindpayClient } from '@/native-plugins/blindpay/blindpay.client';
import type { BlindpayOfframpApi } from '@/native-plugins/blindpay/blindpay-offramp.api';
import type { BlindpayOnrampApi } from '@/native-plugins/blindpay/blindpay-onramp.api';
import { BlindpayReconcilerService } from '@/native-plugins/blindpay/blindpay-reconciler.service';
import { BlindpaySyncService } from '@/native-plugins/blindpay/blindpay-sync.service';
import { OfframpService } from '@/native-plugins/blindpay/offramp/offramp.service';

/**
 * The orphan and duplicate-notification cases end to end: the real sync
 * service, reconciler, offramp service and terminal emitter, over an in-memory
 * stand-in for the six tables they touch. Mocked call assertions could not show
 * that a row written by one path is the row another path later repairs, or that
 * three paths seeing one completion notify once; the stand-in keeps the rows.
 */

type Row = Record<string, any>;

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

/** The subset of Prisma's `where` the code under test uses, with SQL's NULL rules. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[key] ?? null;
    if (cond === null) {
      if (value !== null) return false;
      continue;
    }
    if (typeof cond !== 'object' || cond instanceof Date) {
      if (value !== cond) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(cond as Row)) {
      if (arg === undefined) continue;
      const ok =
        op === 'not'
          ? arg === null
            ? value !== null
            : value !== null && value !== arg
          : op === 'notIn'
            ? value !== null && !(arg as unknown[]).includes(value)
            : op === 'in'
              ? (arg as unknown[]).includes(value)
              : op === 'lt'
                ? value !== null && value < arg
                : op === 'gte'
                  ? value !== null && value >= arg
                  : false;
      if (!ok) return false;
    }
  }
  return true;
}

let seq = 0;

class FakeTable {
  rows: Row[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly uniques: string[][],
    private readonly defaults: Row = {},
  ) {}

  private project(row: Row, args: Row = {}): Row {
    const { select, include } = args;
    const consumer = () => ({
      id: row.consumerId,
      apisixUsername: this.db.consumers[row.consumerId],
    });
    if (select) {
      const out: Row = {};
      for (const [key, on] of Object.entries(select as Row)) {
        if (!on) continue;
        if (key === 'consumer') {
          const c = consumer();
          out.consumer = on === true ? c : { apisixUsername: c.apisixUsername };
        } else {
          out[key] = row[key] ?? null;
        }
      }
      return out;
    }
    return include?.consumer ? { ...row, consumer: consumer() } : { ...row };
  }

  private assertUnique(candidate: Row): void {
    for (const fields of this.uniques) {
      if (
        fields.some((f) => candidate[f] === null || candidate[f] === undefined)
      ) {
        continue;
      }
      const clash = this.rows.some(
        (r) =>
          r.id !== candidate.id && fields.every((f) => r[f] === candidate[f]),
      );
      if (clash) throw uniqueViolation();
    }
  }

  /** `{ consumerId_blindpayId: {…} }` → `{ consumerId, blindpayId }`. */
  private flat(where: Row): Row {
    const out: Row = {};
    for (const [key, value] of Object.entries(where)) {
      if (key.includes('_') && value && typeof value === 'object') {
        Object.assign(out, value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private write(row: Row, data: Row): void {
    const next = { ...row };
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) next[key] = value;
    }
    next.updatedAt = new Date();
    this.assertUnique(next);
    Object.assign(row, next);
  }

  create = jest.fn(async (args: Row) => {
    const row: Row = {
      id: `row_${++seq}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...this.defaults,
      ...args.data,
    };
    this.assertUnique(row);
    this.rows.push(row);
    return this.project(row, args);
  });

  findUnique = jest.fn(async (args: Row) => {
    const row = this.rows.find((r) => matches(r, this.flat(args.where)));
    return row ? this.project(row, args) : null;
  });

  findUniqueOrThrow = jest.fn(async (args: Row) => {
    const found = await this.findUnique(args);
    if (!found) throw new Error('No record found');
    return found;
  });

  findFirst = jest.fn(async (args: Row) => {
    const row = this.rows.find((r) => matches(r, args.where));
    return row ? this.project(row, args) : null;
  });

  findMany = jest.fn(async (args: Row = {}) =>
    this.rows
      .filter((r) => matches(r, args.where))
      .slice(0, args.take ?? Infinity)
      .map((r) => this.project(r, args)),
  );

  updateMany = jest.fn(async (args: Row) => {
    const hit = this.rows.filter((r) => matches(r, args.where));
    for (const row of hit) this.write(row, args.data);
    return { count: hit.length };
  });

  update = jest.fn(async (args: Row) => {
    const row = this.rows.find((r) => matches(r, this.flat(args.where)));
    if (!row) throw new Error('Record to update not found');
    this.write(row, args.data);
    return this.project(row, args);
  });

  upsert = jest.fn(async (args: Row) => {
    const row = this.rows.find((r) => matches(r, this.flat(args.where)));
    if (row) {
      this.write(row, args.update);
      return this.project(row, args);
    }
    return this.create({ data: args.create, select: args.select });
  });

  deleteMany = jest.fn(async (args: Row) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  });

  count = jest.fn(
    async (args: Row = {}) =>
      this.rows.filter((r) => matches(r, args.where)).length,
  );
}

class FakeDb {
  consumers: Record<string, string> = { c1: 'cosmos_u1' };
  payin = new FakeTable(
    this,
    [['executionKey'], ['consumerId', 'blindpayId']],
    {
      environment: 'prod',
      lastCheckedAt: null,
    },
  );
  payout = new FakeTable(
    this,
    [['executionKey'], ['consumerId', 'blindpayId']],
    {
      environment: 'prod',
      lastCheckedAt: null,
    },
  );
  blindpayQuote = new FakeTable(this, [['consumerId', 'blindpayId']]);
  blindpayReceiver = new FakeTable(this, [['consumerId', 'blindpayId']]);
  blindpayWebhookEvent = new FakeTable(this, [['svixId']], {
    appliedAt: null,
    lastAttemptAt: null,
  });
  webhookEmittedEvent = new FakeTable(this, [['dedupKey']]);
}

const EXECUTION_KEY = '48b581d5-a18d-41a7-a3ff-ccfa8f8499fd';
const QUOTE_ID = 'qe_000000000001';
const MINUTE = 60_000;

function setup() {
  const db = new FakeDb();
  const prisma = db as unknown as PrismaService;
  const bus = { emit: jest.fn() };
  // Unwired (no dispatcher): the claim alone, then the bus — the dedup is the
  // same unique key the running service uses.
  const emitter = new WebhookTerminalEmitter(prisma, bus as any);
  const sync = new BlindpaySyncService(prisma, emitter);

  const onramp = { getPayin: jest.fn() };
  const offramp = {
    getPayout: jest.fn(),
    createPayout: jest.fn(),
    environmentFor: jest.fn(() => 'prod'),
  };
  const cfg: Record<string, unknown> = {
    observer: { enabled: true },
    blindpay: { timeoutMs: 1000 },
  };
  const config = {
    get: (key: string) => cfg[key],
  } as unknown as ConfigService<any, true>;
  const client = {
    // Only production is configured; the dev instance is never read.
    instance: jest.fn((env: string) => ({ isConfigured: env === 'prod' })),
  };
  const locks = {
    runExclusive: jest.fn((_key: unknown, work: () => Promise<unknown>) =>
      work(),
    ),
  };
  const reconciler = new BlindpayReconcilerService(
    config,
    prisma,
    client as unknown as BlindpayClient,
    onramp as unknown as BlindpayOnrampApi,
    offramp as unknown as BlindpayOfframpApi,
    sync,
    locks as unknown as AdvisoryLockService,
  );
  const offrampService = new OfframpService(
    prisma,
    offramp as any,
    { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) } as any,
    sync,
  );

  /** Every notification that reached the bus, as `type:resource-id`. */
  const emitted = () =>
    bus.emit.mock.calls
      .filter(([name]) => name === WEBHOOK_EVENT)
      .map(([, payload]: [string, WebhookEventPayload]) => {
        const data = payload.data as { id: string };
        return `${payload.type}:${data.id}`;
      });

  /** A payout quote the consumer minted, as `recordQuoteOwnership` writes it. */
  const ownQuote = () =>
    db.blindpayQuote.rows.push({
      id: 'q1',
      consumerId: 'c1',
      environment: 'prod',
      blindpayId: QUOTE_ID,
      kind: 'PAYOUT',
      expiresAt: new Date(Date.now() + 5 * MINUTE),
      executionKey: EXECUTION_KEY,
      createdAt: new Date(),
    });

  /** Ages every row past the mirror's freshness window. */
  const age = (table: FakeTable, ms = 2 * MINUTE) => {
    for (const row of table.rows) {
      row.updatedAt = new Date(Date.now() - ms);
      row.createdAt = new Date(Date.now() - ms);
    }
  };

  return {
    db,
    sync,
    reconciler,
    offramp,
    onramp,
    offrampService,
    emitted,
    ownQuote,
    age,
  };
}

const DTO = {
  quote_id: QUOTE_ID,
  chain: 'stellar',
  sender_wallet_address: 'GABC',
  signed_transaction: 'AAAA',
} as any;

describe('a payout BlindPay created but we failed to record', () => {
  it('keeps a recoverable row, which the webhook fills and the reconciler settles, notifying once', async () => {
    const t = setup();
    t.ownQuote();
    t.offramp.createPayout.mockResolvedValue({
      id: 'pa_1',
      quote_id: QUOTE_ID,
      status: 'processing',
    });
    // The write after the provider call fails (the database blinked).
    t.db.payout.updateMany.mockRejectedValueOnce(new Error('connection reset'));

    const answer = await t.offrampService.createPayout(
      { username: 'cosmos_u1' } as any,
      DTO,
    );

    // The caller still gets the payout BlindPay created, under the row's id.
    expect(answer).toMatchObject({ blindpayId: 'pa_1', status: 'processing' });
    const [row] = t.db.payout.rows;
    expect(answer.id).toBe(row.id);
    // And the row survives, carrying what links it to the provider's payout.
    expect(row.blindpayId ?? null).toBeNull();
    expect(row).toMatchObject({
      quoteId: QUOTE_ID,
      executionKey: EXECUTION_KEY,
      status: 'pending_provider',
    });

    // BlindPay's own report of the payout names the quote: that fills the row.
    await t.sync.handleWebhook(
      'prod',
      'payout.update',
      { id: 'pa_1', quote_id: QUOTE_ID, status: 'processing' },
      'msg_1',
    );
    expect(t.db.payout.rows).toHaveLength(1);
    expect(t.db.payout.rows[0]).toMatchObject({
      blindpayId: 'pa_1',
      status: 'processing',
    });

    // The completion webhook never arrives; the reconciler finds it.
    t.age(t.db.payout);
    t.offramp.getPayout.mockResolvedValue({
      id: 'pa_1',
      quote_id: QUOTE_ID,
      status: 'completed',
    });
    await t.reconciler.tick();
    await t.reconciler.tick();

    expect(t.offramp.getPayout).toHaveBeenCalledWith('prod', 'pa_1');
    expect(t.db.payout.rows[0].status).toBe('completed');
    expect(t.emitted()).toEqual([
      'PAYOUT_UPDATED:pa_1',
      'PAYOUT_COMPLETED:pa_1',
    ]);
  });

  it('lets a retried create with the same quote reuse the row its first attempt opened', async () => {
    const t = setup();
    t.ownQuote();
    t.offramp.createPayout.mockRejectedValueOnce(
      new HttpException('BlindPay request timed out', 504),
    );

    await expect(
      t.offrampService.createPayout({ username: 'cosmos_u1' } as any, DTO),
    ).rejects.toThrow('timed out');
    expect(t.db.payout.rows).toHaveLength(1);

    // BlindPay replays the original answer for the same Idempotency-Key.
    t.offramp.createPayout.mockResolvedValue({
      id: 'pa_1',
      quote_id: QUOTE_ID,
      status: 'processing',
    });
    const answer = await t.offrampService.createPayout(
      { username: 'cosmos_u1' } as any,
      DTO,
    );

    expect(t.offramp.createPayout).toHaveBeenLastCalledWith(
      'prod',
      'stellar',
      expect.anything(),
      EXECUTION_KEY,
    );
    expect(t.db.payout.rows).toHaveLength(1);
    expect(answer).toMatchObject({
      id: t.db.payout.rows[0].id,
      blindpayId: 'pa_1',
    });
  });

  it('hides a row still waiting for its provider id from tenant reads', async () => {
    const t = setup();
    t.ownQuote();
    t.offramp.createPayout.mockRejectedValue(new HttpException('down', 502));
    await expect(
      t.offrampService.createPayout({ username: 'cosmos_u1' } as any, DTO),
    ).rejects.toThrow();

    const list = await t.offrampService.findAll(
      { username: 'cosmos_u1' } as any,
      { take: 10, skip: 0 },
    );
    expect(list).toMatchObject({ data: [], total: 0 });
    await expect(
      t.offrampService.findOne(
        { username: 'cosmos_u1' } as any,
        t.db.payout.rows[0].id,
      ),
    ).rejects.toThrow('Payout not found');
  });

  it('marks a row that never received a provider id unconfirmed, once', async () => {
    const t = setup();
    t.ownQuote();
    t.offramp.createPayout.mockRejectedValue(new HttpException('down', 502));
    await expect(
      t.offrampService.createPayout({ username: 'cosmos_u1' } as any, DTO),
    ).rejects.toThrow();

    await t.reconciler.tick();
    expect(t.db.payout.rows[0].status).toBe('pending_provider');

    t.age(t.db.payout, 2 * 60 * MINUTE);
    await t.reconciler.tick();
    expect(t.db.payout.rows[0].status).toBe('provider_unconfirmed');
    // Nothing re-sent the create: it might have been paid another way since.
    expect(t.offramp.createPayout).toHaveBeenCalledTimes(1);
  });
});

describe('BlindPay webhooks that match no local row', () => {
  it('creates the mirror for an unknown payout whose quote we issued', async () => {
    const t = setup();
    t.ownQuote();

    await t.sync.handleWebhook(
      'prod',
      'payout.new',
      { id: 'pa_9', quote_id: QUOTE_ID, status: 'processing' },
      'msg_new',
    );

    expect(t.db.payout.rows).toEqual([
      expect.objectContaining({
        consumerId: 'c1',
        environment: 'prod',
        blindpayId: 'pa_9',
        quoteId: QUOTE_ID,
      }),
    ]);
    expect(t.emitted()).toEqual(['PAYOUT_CREATED:pa_9']);
    expect(t.db.blindpayWebhookEvent.rows[0].appliedAt).toBeInstanceOf(Date);
  });

  it('never attributes through a quote minted on the other instance', async () => {
    const t = setup();
    t.ownQuote();

    await t.sync.handleWebhook(
      'dev',
      'payout.new',
      { id: 'pa_9', quote_id: QUOTE_ID },
      'msg_dev',
    );

    expect(t.db.payout.rows).toHaveLength(0);
    expect(t.emitted()).toEqual([]);
  });

  it('keeps a truly unknown event open, and applies it once it can be attributed', async () => {
    const t = setup();
    await t.sync.handleWebhook(
      'prod',
      'payout.complete',
      { id: 'pa_7', quote_id: QUOTE_ID, status: 'completed' },
      'msg_unknown',
    );

    // Acknowledged (no throw) but not forgotten: the delivery is still open.
    const [event] = t.db.blindpayWebhookEvent.rows;
    expect(event).toMatchObject({
      svixId: 'msg_unknown',
      environment: 'prod',
      blindpayId: 'pa_7',
      appliedAt: null,
    });
    expect(t.emitted()).toEqual([]);

    // Nothing to attribute it to yet: the reconciler tries, and keeps it.
    t.age(t.db.blindpayWebhookEvent);
    t.offramp.getPayout.mockResolvedValue({
      id: 'pa_7',
      quote_id: QUOTE_ID,
      status: 'completed',
    });
    await t.reconciler.tick();
    expect(t.db.blindpayWebhookEvent.rows[0].appliedAt).toBeNull();
    expect(t.db.blindpayWebhookEvent.rows[0].lastAttemptAt).toBeInstanceOf(
      Date,
    );

    // The quote's ownership is now known (it was being written concurrently).
    t.ownQuote();
    await t.reconciler.tick();
    await t.reconciler.tick();

    expect(t.offramp.getPayout).toHaveBeenCalledWith('prod', 'pa_7');
    expect(t.db.payout.rows).toEqual([
      expect.objectContaining({ blindpayId: 'pa_7', status: 'completed' }),
    ]);
    expect(t.db.blindpayWebhookEvent.rows[0].appliedAt).toBeInstanceOf(Date);
    expect(t.emitted()).toEqual(['PAYOUT_COMPLETED:pa_7']);
  });

  it('applies a Svix retry of a delivery that was left open instead of dropping it', async () => {
    const t = setup();
    const data = { id: 'pa_8', quote_id: QUOTE_ID, status: 'processing' };
    await t.sync.handleWebhook('prod', 'payout.new', data, 'msg_open');
    t.ownQuote();

    await t.sync.handleWebhook('prod', 'payout.new', data, 'msg_open');
    // A further retry of the now-closed delivery is a replay.
    await t.sync.handleWebhook('prod', 'payout.new', data, 'msg_open');

    expect(t.db.payout.rows).toHaveLength(1);
    expect(t.emitted()).toEqual(['PAYOUT_CREATED:pa_8']);
  });
});

describe('BlindPay terminal events', () => {
  function withPayout(status = 'processing') {
    const t = setup();
    t.db.payout.rows.push({
      id: 'local_1',
      consumerId: 'c1',
      environment: 'prod',
      blindpayId: 'pa_1',
      quoteId: QUOTE_ID,
      status,
      lastCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return t;
  }

  it('notifies a completion once, even when it is sent again under a new svix-id', async () => {
    const t = withPayout();
    const data = { id: 'pa_1', quote_id: QUOTE_ID, status: 'completed' };

    await t.sync.handleWebhook('prod', 'payout.complete', data, 'msg_a');
    await t.sync.handleWebhook('prod', 'payout.complete', data, 'msg_b');

    expect(t.emitted()).toEqual(['PAYOUT_COMPLETED:pa_1']);
  });

  it('notifies once when the reconciler saw the completion before the webhook', async () => {
    const t = withPayout();
    t.age(t.db.payout);
    t.offramp.getPayout.mockResolvedValue({ id: 'pa_1', status: 'completed' });

    await t.reconciler.tick();
    await t.sync.handleWebhook(
      'prod',
      'payout.complete',
      { id: 'pa_1', status: 'completed' },
      'msg_late',
    );

    expect(t.emitted()).toEqual(['PAYOUT_COMPLETED:pa_1']);
  });

  it('still notifies a completion a tenant read already mirrored without notifying', async () => {
    // GET /v1/offramp/payouts/:id refreshes the row but notifies nobody, so
    // the webhook that follows finds nothing left to move. It must still be
    // the one that tells the integrator.
    const t = withPayout('completed');

    await t.sync.handleWebhook(
      'prod',
      'payout.complete',
      { id: 'pa_1', status: 'completed' },
      'msg_after_read',
    );

    expect(t.emitted()).toEqual(['PAYOUT_COMPLETED:pa_1']);
  });

  it('does not re-emit an update a guarded write refused', async () => {
    const t = withPayout('completed');

    await t.sync.handleWebhook(
      'prod',
      'payout.update',
      { id: 'pa_1', status: 'processing' },
      'msg_stale',
    );

    expect(t.db.payout.rows[0].status).toBe('completed');
    expect(t.emitted()).toEqual([]);
  });
});

describe('BlindpayReconcilerService', () => {
  it('repairs an open payin from BlindPay and leaves settled and fresh rows alone', async () => {
    const t = setup();
    const base = {
      consumerId: 'c1',
      environment: 'prod',
      lastCheckedAt: null,
      createdAt: new Date(),
    };
    t.db.payin.rows.push(
      { ...base, id: 'open', blindpayId: 'pi_open', status: 'processing' },
      { ...base, id: 'done', blindpayId: 'pi_done', status: 'completed' },
    );
    t.age(t.db.payin);
    t.db.payin.rows.push({
      ...base,
      id: 'fresh',
      blindpayId: 'pi_fresh',
      status: 'processing',
      updatedAt: new Date(),
    });
    t.onramp.getPayin.mockImplementation((_env: string, id: string) =>
      Promise.resolve({ id, status: 'on_hold' }),
    );

    await t.reconciler.tick();

    expect(t.onramp.getPayin).toHaveBeenCalledTimes(1);
    expect(t.onramp.getPayin).toHaveBeenCalledWith('prod', 'pi_open');
    expect(t.db.payin.rows[0]).toMatchObject({ status: 'on_hold' });
    expect(t.db.payin.rows[0].lastCheckedAt).toBeInstanceOf(Date);
    expect(t.emitted()).toEqual(['PAYIN_UPDATED:pi_open']);

    // Unchanged on the next read: no second notification. (The row that was
    // fresh is old enough by now, and is read for the first time.)
    t.age(t.db.payin);
    await t.reconciler.tick();
    expect(t.emitted()).toEqual([
      'PAYIN_UPDATED:pi_open',
      'PAYIN_UPDATED:pi_fresh',
    ]);
  });

  it('keeps going past a row BlindPay fails on, and sends it to the back', async () => {
    const t = setup();
    const base = {
      consumerId: 'c1',
      environment: 'prod',
      status: 'processing',
      lastCheckedAt: null,
      createdAt: new Date(),
    };
    t.db.payout.rows.push(
      { ...base, id: 'a', blindpayId: 'pa_a' },
      { ...base, id: 'b', blindpayId: 'pa_b' },
    );
    t.age(t.db.payout);
    t.offramp.getPayout
      .mockRejectedValueOnce(new HttpException('down', 502))
      .mockResolvedValueOnce({ id: 'pa_b', status: 'completed' });

    await t.reconciler.tick();

    expect(t.db.payout.rows[0].lastCheckedAt).toBeInstanceOf(Date);
    expect(t.db.payout.rows[1].status).toBe('completed');
    expect(t.emitted()).toEqual(['PAYOUT_COMPLETED:pa_b']);
  });

  it('never reads an instance this deployment did not configure', async () => {
    const t = setup();
    t.db.payout.rows.push({
      id: 'dev_row',
      consumerId: 'c1',
      environment: 'dev',
      blindpayId: 'pa_dev',
      status: 'processing',
      lastCheckedAt: null,
      createdAt: new Date(),
    });
    t.age(t.db.payout);

    await t.reconciler.tick();

    expect(t.offramp.getPayout).not.toHaveBeenCalled();
  });
});
