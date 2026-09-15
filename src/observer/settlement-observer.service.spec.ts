import { AdvisoryLockKey } from '@/common/services/advisory-lock.service';
import { SETTLEMENT_MAX_ROWS_PER_CONSUMER } from '@/observer/observer.constants';
import { SettlementObserverService } from '@/observer/settlement-observer.service';

/**
 * The ranking itself is SQL (a window function Prisma cannot express), so these
 * pin its shape and what the sweep does with the rows it deals. The settlement
 * branches — duplicate hashes, submit races — are covered next to the domain
 * services in the swaps and liquidity-pools specs.
 *
 * The fairness tests drive `reconcile` directly, so the cost basis service and
 * the advisory lock are stubs there; the last block covers the scheduled tick
 * that wraps the sweep.
 */

type Outcome = 'succeeded' | 'failed' | number;

function inflightRow(
  id: string,
  consumer: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id,
    consumerId: consumer,
    status: 'PENDING',
    network: 'testnet',
    txHash: `tx_${id}`,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    consumer: { apisixUsername: consumer },
    ...overrides,
  };
}

/** A store for both tables; `findMany` honours only what the re-read uses. */
function makePrisma(swaps: any[], operations: any[] = []) {
  const table = (rows: any[]) => ({
    findMany: jest.fn(async ({ where }: any) =>
      rows
        .filter(
          (r) =>
            where.id.in.includes(r.id) && where.status.in.includes(r.status),
        )
        .map((r) => ({ ...r })),
    ),
  });
  return {
    swap: table(swaps),
    liquidityPoolOperation: table(operations),
    // What the ranking query deals this tick; set per test.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

/** Horizon by hash: an outcome per txHash, 404 for anything not listed. */
function makeStellar(outcomes: Record<string, Outcome> = {}) {
  const lookups: string[] = [];
  const stellar = {
    server: jest.fn(() => ({
      transactions: () => ({
        transaction: (hash: string) => ({
          call: () => {
            lookups.push(hash);
            const outcome = outcomes[hash] ?? 404;
            if (outcome === 'succeeded') {
              return Promise.resolve({ successful: true });
            }
            if (outcome === 'failed') {
              return Promise.resolve({ successful: false });
            }
            return Promise.reject(
              Object.assign(new Error('Horizon'), {
                response: { status: outcome },
              }),
            );
          },
        }),
      }),
    })),
  };
  return { stellar, lookups };
}

function makeDomain() {
  const won = (id: string) =>
    Promise.resolve({ applied: true, swap: { id }, operation: { id } });
  return {
    finalizeSucceeded: jest.fn(won),
    finalizeSucceededQuiet: jest.fn(won),
    finalizeFailed: jest.fn(won),
    finalizeFailedQuiet: jest.fn(won),
    finalizeExpired: jest.fn(won),
  };
}

const config = {
  get: () => ({ enabled: false, intervalMs: 15_000, batchSize: 50 }),
} as any;

function dealt(...ids: string[]) {
  return ids.map((id) => ({ id }));
}

describe('SettlementObserverService — one tick is fair across consumers', () => {
  it('ranks in-flight swaps per consumer, capped, within the batch', async () => {
    const prisma = makePrisma([]);
    const { stellar } = makeStellar();
    const observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      makeDomain() as any,
      makeDomain() as any,
      {} as any,
      {} as any,
    );

    await (observer as any).reconcile('swaps', 50);

    const [sql, ...values] = prisma.$queryRaw.mock.calls[0];
    const text = (sql as string[]).join('?');
    expect(text).toMatch(/FROM "swap"/);
    expect(text).toMatch(
      /PARTITION BY "consumerId" ORDER BY "createdAt", "id"/,
    );
    expect(text).toMatch(/"status" IN \('PENDING', 'SUBMITTED'\)/);
    // Every consumer's oldest row before anyone's second.
    expect(text).toMatch(/ORDER BY "rank", "createdAt", "id"/);
    expect(values).toEqual([SETTLEMENT_MAX_ROWS_PER_CONSUMER, 50]);
    // Nothing dealt, nothing re-read.
    expect(prisma.swap.findMany).not.toHaveBeenCalled();
  });

  it('ranks liquidity pool operations the same way', async () => {
    const prisma = makePrisma([]);
    const { stellar } = makeStellar();
    const observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      makeDomain() as any,
      makeDomain() as any,
      {} as any,
      {} as any,
    );

    await (observer as any).reconcile('liquidity', 50);

    const [sql, ...values] = prisma.$queryRaw.mock.calls[0];
    const text = (sql as string[]).join('?');
    expect(text).toMatch(/FROM "liquidity_pool_operation"/);
    expect(text).toMatch(/PARTITION BY "consumerId"/);
    expect(values).toEqual([SETTLEMENT_MAX_ROWS_PER_CONSUMER, 50]);
  });

  it("looks up only what was dealt, however large one consumer's backlog", async () => {
    // A flood on the shared public key used to fill the whole batch oldest-
    // first; a quiet tenant's settled swap waited behind every row of it.
    const flood = Array.from({ length: 40 }, (_, i) =>
      inflightRow(`flood_${i}`, 'cosmos_public'),
    );
    const quiet = inflightRow('quiet', 'cosmos_u1');
    const prisma = makePrisma([...flood, quiet]);
    prisma.$queryRaw.mockResolvedValue(
      dealt(
        'flood_0',
        'quiet',
        ...flood.slice(1, SETTLEMENT_MAX_ROWS_PER_CONSUMER).map((r) => r.id),
      ),
    );
    const { stellar, lookups } = makeStellar({ tx_quiet: 'succeeded' });
    const swaps = makeDomain();
    const observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      makeDomain() as any,
      swaps as any,
      {} as any,
      {} as any,
    );

    await (observer as any).reconcile('swaps', 50);

    expect(lookups).toHaveLength(SETTLEMENT_MAX_ROWS_PER_CONSUMER + 1);
    expect(lookups).toContain('tx_quiet');
    expect(swaps.finalizeSucceeded).toHaveBeenCalledWith('quiet', 'cosmos_u1');
  });

  it('spends no Horizon lookup on a row finalized between the ranking and the re-read', async () => {
    // `submit` settled it in the meantime; it can no longer settle again.
    const settled = inflightRow('settled', 'cosmos_u1', {
      status: 'SUCCEEDED',
    });
    const prisma = makePrisma([settled]);
    prisma.$queryRaw.mockResolvedValue(dealt('settled'));
    const { stellar, lookups } = makeStellar({ tx_settled: 'succeeded' });
    const swaps = makeDomain();
    const observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      makeDomain() as any,
      swaps as any,
      {} as any,
      {} as any,
    );

    await (observer as any).reconcile('swaps', 50);

    expect(lookups).toHaveLength(0);
    expect(swaps.finalizeSucceeded).not.toHaveBeenCalled();
  });

  it('still deals lapsed rows, and expires one only on a Horizon 404', async () => {
    // A row past its timebounds may have settled before they closed, so the
    // ranking must not drop it and an unreachable Horizon must not expire it.
    const lapsed = { expiresAt: new Date(Date.now() - 60_000) };
    const unreachable = inflightRow('unreachable', 'cosmos_u1', lapsed);
    const absent = inflightRow('absent', 'cosmos_u2', lapsed);
    const prisma = makePrisma([], [unreachable, absent]);
    prisma.$queryRaw.mockResolvedValue(dealt('unreachable', 'absent'));
    const { stellar } = makeStellar({ tx_unreachable: 503 });
    const liquidity = makeDomain();
    const observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      liquidity as any,
      makeDomain() as any,
      {} as any,
      {} as any,
    );

    await (observer as any).reconcile('liquidity', 50);

    const text = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(text).not.toMatch(/expiresAt/);
    expect(liquidity.finalizeExpired).toHaveBeenCalledTimes(1);
    expect(liquidity.finalizeExpired).toHaveBeenCalledWith('absent');
  });
});

describe('SettlementObserverService — runs as a ScheduledJob', () => {
  function observerConfig(overrides: Record<string, unknown> = {}) {
    return {
      get: () => ({
        enabled: true,
        intervalMs: 15_000,
        batchSize: 50,
        ...overrides,
      }),
    } as any;
  }

  /** Nothing in flight and no deposit missing its basis. */
  function quietPrisma() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      swap: { findMany: jest.fn() },
      liquidityPoolOperation: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
    };
  }

  function make(
    config: any,
    prisma: ReturnType<typeof quietPrisma> = quietPrisma(),
    basis: any = { captureDepositBasis: jest.fn() },
  ) {
    const locks = {
      runExclusive: jest.fn(
        async (_key: unknown, work: () => Promise<unknown>, _ms?: number) =>
          work(),
      ),
    };
    const { stellar } = makeStellar();
    const observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      makeDomain() as any,
      makeDomain() as any,
      basis,
      locks as any,
    );
    return { observer, locks, prisma };
  }

  it('sweeps under the SettlementObserver lock, bounded by four intervals', async () => {
    const { observer, locks } = make(observerConfig({ intervalMs: 30_000 }));

    await observer.tick();

    expect(locks.runExclusive).toHaveBeenCalledWith(
      AdvisoryLockKey.SettlementObserver,
      expect.any(Function),
      120_000,
    );
  });

  it('never bounds the lock below one minute', async () => {
    const { observer, locks } = make(observerConfig({ intervalMs: 5_000 }));

    await observer.tick();

    expect(locks.runExclusive.mock.calls[0][2]).toBe(60_000);
  });

  it('reconciles swaps, then liquidity pool operations, then backfills cost basis', async () => {
    const { observer, prisma } = make(observerConfig());

    await observer.tick();

    const tables = prisma.$queryRaw.mock.calls.map(
      ([sql]) => /FROM "(\w+)"/.exec((sql as string[]).join('?'))?.[1],
    );
    expect(tables).toEqual(['swap', 'liquidity_pool_operation']);
    expect(prisma.liquidityPoolOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind: 'DEPOSIT', status: 'SUCCEEDED', sharesReceived: null },
        take: 50,
      }),
    );
    expect(
      prisma.liquidityPoolOperation.findMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(prisma.$queryRaw.mock.invocationCallOrder[1]);
  });

  it('sweeps nothing on a replica that lost the lock', async () => {
    const { observer, locks, prisma } = make(observerConfig());
    locks.runExclusive.mockResolvedValue(undefined);

    await observer.tick();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.liquidityPoolOperation.findMany).not.toHaveBeenCalled();
  });

  it('backfills a missing deposit basis through the cost basis service', async () => {
    const op = {
      id: 'dep_1',
      kind: 'DEPOSIT',
      status: 'SUCCEEDED',
      sharesReceived: null,
    };
    const prisma = quietPrisma();
    prisma.liquidityPoolOperation.findMany.mockResolvedValue([op]);
    prisma.liquidityPoolOperation.findUnique.mockResolvedValue({
      sharesReceived: '100',
    });
    const basis = {
      captureDepositBasis: jest.fn().mockResolvedValue(undefined),
    };
    const { observer } = make(observerConfig(), prisma, basis);

    await observer.tick();

    expect(basis.captureDepositBasis).toHaveBeenCalledWith(op);
  });

  it('survives a sweep that throws, so the timer keeps firing', async () => {
    const { observer, locks } = make(observerConfig());
    locks.runExclusive.mockRejectedValue(new Error('connection reset'));

    await expect(observer.tick()).resolves.toBeUndefined();
  });

  it('starts no timer when OBSERVER_ENABLED=false', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    try {
      make(observerConfig({ enabled: false })).observer.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('polls every OBSERVER_INTERVAL_MS on an unref-ed timer when enabled', () => {
    const timer = { unref: jest.fn() };
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(timer as any);
    const clearIntervalSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);
    try {
      const { observer } = make(observerConfig({ intervalMs: 7_000 }));

      observer.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
      expect(timer.unref).toHaveBeenCalled();

      observer.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
