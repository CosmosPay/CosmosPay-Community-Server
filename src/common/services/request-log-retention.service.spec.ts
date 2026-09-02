import { Logger } from '@nestjs/common';
import { RequestLogRetentionService } from './request-log-retention.service';

describe('RequestLogRetentionService', () => {
  const retentionCfg = {
    retentionDays: 30,
    pruneIntervalMs: 3600000,
    batchSize: 2,
    maxPerCycle: 6,
    deliveryPayloadDays: 0,
  };

  function build(cfg: typeof retentionCfg = retentionCfg) {
    const prisma = {
      requestLog: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      webhookDelivery: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const config = { get: () => cfg } as any;
    // The real lock runs `work` only when this replica wins pg_try_advisory_xact_lock.
    // Here it always wins, so these tests exercise the prune itself; the
    // lost-the-race path is covered separately below.
    const lock = {
      runExclusive: jest.fn((_key: number, work: () => Promise<unknown>) =>
        work(),
      ),
    };
    const service = new RequestLogRetentionService(
      config,
      prisma as any,
      lock as any,
    );
    return { service, prisma, lock };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('skips the timer only when BOTH retentions are off', () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const { service } = build({
      retentionDays: 0,
      pruneIntervalMs: 3600000,
      batchSize: 1000,
      maxPerCycle: 50000,
      deliveryPayloadDays: 0,
    });
    service.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(loggerLog).toHaveBeenCalledWith(
      expect.stringContaining('REQUEST_LOG_RETENTION_DAYS=0'),
    );
    service.onModuleDestroy();
  });

  it('still runs the timer for delivery bodies when request logs are off', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const { service } = build({
      ...retentionCfg,
      retentionDays: 0,
      deliveryPayloadDays: 30,
    });
    service.onModuleInit();

    // The timer serves two prunes; turning one off must not disable the other.
    expect(setIntervalSpy).toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('clears the body of settled deliveries past the window, once', async () => {
    const { service, prisma } = build({
      ...retentionCfg,
      retentionDays: 0,
      deliveryPayloadDays: 30,
      batchSize: 2,
      maxPerCycle: 2,
    });
    prisma.webhookDelivery.findMany.mockResolvedValueOnce([
      { id: 'wd_1' },
      { id: 'wd_2' },
    ]);
    prisma.webhookDelivery.updateMany.mockResolvedValueOnce({ count: 2 });

    await (service as unknown as { tick: () => Promise<void> }).tick();

    const where = prisma.webhookDelivery.findMany.mock.calls[0][0].where;
    // A retryable delivery still needs its body to re-send what was signed.
    expect(where.status).toEqual({ in: ['SUCCEEDED', 'FAILED'] });
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // Already-cleared rows are excluded, so the loop cannot spin on them.
    expect(where.NOT).toEqual({ payload: { equals: { redacted: true } } });
    expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['wd_1', 'wd_2'] } },
      data: { payload: { redacted: true } },
    });
  });

  it('does not touch delivery bodies when the window is 0', async () => {
    const { service, prisma } = build({
      ...retentionCfg,
      retentionDays: 0,
      deliveryPayloadDays: 0,
    });

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('starts an unrefed interval when retention is enabled', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer);

    const { service } = build();
    service.onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      retentionCfg.pruneIntervalMs,
    );
    expect((fakeTimer as any).unref).toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('loops batches until a short page, then logs the total deleted', async () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const { service, prisma } = build();
    prisma.requestLog.findMany
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
      .mockResolvedValueOnce([{ id: 'c' }]); // short page → stop
    prisma.requestLog.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    await (service as any).tick();

    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.requestLog.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.requestLog.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['a', 'b'] } },
    });
    expect(prisma.requestLog.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['c'] } },
    });
    expect(loggerLog).toHaveBeenCalledWith(
      expect.stringMatching(/Request log prune deleted 3 row/),
    );
  });

  it('stops at maxPerCycle even when more stale rows remain', async () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service, prisma } = build(); // maxPerCycle=6, batchSize=2 → 3 batches

    prisma.requestLog.findMany.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
    prisma.requestLog.deleteMany.mockResolvedValue({ count: 2 });

    await (service as any).tick();

    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.requestLog.deleteMany).toHaveBeenCalledTimes(3);
    expect(loggerLog).toHaveBeenCalledWith(
      expect.stringMatching(/Request log prune deleted 6 row/),
    );
  });

  it('does not delete when there are no stale rows', async () => {
    const { service, prisma } = build();
    await (service as any).tick();
    expect(prisma.requestLog.deleteMany).not.toHaveBeenCalled();
  });

  it('does not start a second cycle while one is still running', async () => {
    const { service, prisma } = build();
    let resolveFind!: (v: unknown) => void;
    prisma.requestLog.findMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFind = resolve;
        }),
    );

    const first = (service as any).tick();
    const second = (service as any).tick();
    await second;

    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(1);

    resolveFind([]);
    await first;
  });

  it('clearInterval on destroy so the process can exit', () => {
    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation();

    const { service } = build();
    service.onModuleInit();
    service.onModuleDestroy();

    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
  });
  it('bounds the prune by rows EXAMINED, not rows deleted', async () => {
    // The bug this pins: bounding on `deleted` alone turned a bounded prune
    // into an unbounded scan. `deleted` only advances when this cycle wins the
    // delete, so a replica racing a sibling (or a concurrent manual cleanup)
    // sees count 0 on every batch while still finding a full page of
    // candidates — `deleted < cap` stays true forever.
    const { service, prisma } = build({
      ...retentionCfg,
      batchSize: 2,
      maxPerCycle: 6,
      deliveryPayloadDays: 0,
    });
    // Always a full page of candidates...
    prisma.requestLog.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    // ...and this replica never wins the delete.
    prisma.requestLog.deleteMany.mockResolvedValue({ count: 0 });

    await (service as unknown as { tick: () => Promise<void> }).tick();

    // maxPerCycle / batchSize = 3 passes, then it stops. Without the
    // `examined` counter this loop never terminates.
    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(3);
  });

  it('skips the whole cycle when another replica holds the lock', async () => {
    const { service, prisma, lock } = build();
    lock.runExclusive.mockResolvedValue(undefined);

    await (service as unknown as { tick: () => Promise<void> }).tick();

    // Losing the race must cost nothing: no scan, no delete. Every replica runs
    // this timer and they all select the same oldest rows.
    expect(prisma.requestLog.findMany).not.toHaveBeenCalled();
    expect(prisma.requestLog.deleteMany).not.toHaveBeenCalled();
  });
});
