import { Logger } from '@nestjs/common';
import { WebhookDeliverySweeperService } from './webhook-delivery-sweeper.service';

describe('WebhookDeliverySweeperService', () => {
  const webhookCfg = {
    maxAttempts: 3,
    backoffMs: 2000,
    timeoutMs: 5000,
    connectTimeoutMs: 3000,
    readTimeoutMs: 5000,
    maxResponseBytes: 65536,
    signatureHeader: 'x-cosmos-signature',
  };

  /**
   * `configuration.ts` always populates `webhookSweep`, so the stub answers per
   * key rather than returning the `webhooks` section for every lookup — a stub
   * that returns the wrong shape would force the service to carry an env-var
   * fallback purely to satisfy this test, and that fallback would be dead code
   * in production.
   */
  function build(sweep = { enabled: true, intervalMs: 60_000 }) {
    const prisma = {
      webhookDelivery: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const config = {
      get: (key: string) => (key === 'webhookSweep' ? sweep : webhookCfg),
    } as any;
    // The real lock runs `work` only when this replica wins
    // pg_try_advisory_xact_lock; here it always wins, and the lost-the-race
    // path is covered separately below.
    const locks = {
      runExclusive: jest.fn((_key: number, work: () => Promise<unknown>) =>
        work(),
      ),
    };
    const dispatcher = { redeliver: jest.fn().mockResolvedValue(undefined) };
    const service = new WebhookDeliverySweeperService(
      config,
      prisma as any,
      locks as any,
      dispatcher as any,
    );
    return { service, prisma, locks, dispatcher };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete process.env.WEBHOOK_SWEEP_ENABLED;
    delete process.env.WEBHOOK_SWEEP_INTERVAL_MS;
  });

  it('starts an unrefed interval and clears it on destroy', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer);
    const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation();

    const { service } = build();
    service.onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect((fakeTimer as any).unref).toHaveBeenCalled();

    service.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it('stays off when WEBHOOK_SWEEP_ENABLED=false', () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { service } = build({ enabled: false, intervalMs: 60_000 });
    service.onModuleInit();

    // Every background timer in this service has a kill switch an operator can
    // use mid-incident (and the test bootstrap uses to keep timers out).
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(loggerLog).toHaveBeenCalledWith(
      expect.stringContaining('WEBHOOK_SWEEP_ENABLED=false'),
    );
    service.onModuleDestroy();
  });

  it('honours WEBHOOK_SWEEP_INTERVAL_MS', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer);
    const { service } = build({ enabled: true, intervalMs: 5000 });
    service.onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    service.onModuleDestroy();
  });

  it('claims stranded PENDING rows and FAILED rows still in budget, then redelivers', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service, prisma, dispatcher } = build();
    const stranded = { id: 'wd_1', endpointId: 'we_1', attempts: 0 };
    prisma.webhookDelivery.findMany
      .mockResolvedValueOnce([{ id: 'wd_1' }])
      .mockResolvedValueOnce([stranded]);

    await (service as any).tick();

    const [{ where, take, orderBy }] =
      prisma.webhookDelivery.findMany.mock.calls[0];
    // An endpoint we are no longer allowed to talk to must never be retried:
    // undoing an SSRF block from a background timer would be the whole bug
    // back again.
    expect(where.endpoint).toEqual({
      enabled: true,
      destinationBlocked: false,
    });
    const [pending, failed] = where.OR;
    expect(pending.status).toBe('PENDING');
    expect(failed).toEqual({
      status: 'FAILED',
      attempts: { lt: webhookCfg.maxAttempts * 3 },
      lastAttemptAt: { lt: expect.any(Date) },
    });
    expect(orderBy).toEqual({ createdAt: 'asc' });
    expect(take).toBe(25);

    // Claim before send: stamping takes the row out of the predicate so the
    // next tick (or another replica) cannot pick up an in-flight delivery.
    expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['wd_1'] } },
      data: { lastAttemptAt: expect.any(Date) },
    });
    expect(dispatcher.redeliver).toHaveBeenCalledWith(stranded);
  });

  it('only treats a PENDING row as stranded once it outlasts the in-process retry window', async () => {
    const { service, prisma } = build();
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await (service as any).tick();

    const { where } = prisma.webhookDelivery.findMany.mock.calls[0][0];
    const cutoff: Date = where.OR[0].OR[0].createdAt.lt;
    // Worst case in-process: 3 attempts × (3000 + 5000) plus 2000 + 4000 of
    // backoff = 30_000, doubled for headroom.
    expect(now - cutoff.getTime()).toBe(60_000);
  });

  it('does nothing when another replica holds the lock', async () => {
    const { service, prisma, locks, dispatcher } = build();
    locks.runExclusive.mockResolvedValue(undefined);

    await (service as any).tick();

    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
    expect(dispatcher.redeliver).not.toHaveBeenCalled();
  });

  it('does not redeliver when nothing is stranded', async () => {
    const { service, prisma, dispatcher } = build();

    await (service as any).tick();

    expect(prisma.webhookDelivery.updateMany).not.toHaveBeenCalled();
    expect(dispatcher.redeliver).not.toHaveBeenCalled();
  });

  it('does not start a second cycle while one is still running', async () => {
    const { service, prisma } = build();
    let release!: (v: unknown) => void;
    prisma.webhookDelivery.findMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = (service as any).tick();
    await (service as any).tick();

    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledTimes(1);
    release([]);
    await first;
  });

  it('keeps sweeping when one delivery cannot be recovered', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, prisma, dispatcher } = build();
    prisma.webhookDelivery.findMany
      .mockResolvedValueOnce([{ id: 'wd_1' }, { id: 'wd_2' }])
      .mockResolvedValueOnce([{ id: 'wd_1' }, { id: 'wd_2' }]);
    dispatcher.redeliver
      .mockRejectedValueOnce(new Error('Endpoint we_1 no longer exists'))
      .mockResolvedValueOnce(undefined);

    await (service as any).tick();

    expect(dispatcher.redeliver).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not recover delivery wd_1/),
    );
  });
});
