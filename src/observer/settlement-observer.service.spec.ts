import { SETTLEMENT_MAX_ROWS_PER_CONSUMER } from '@/observer/observer.constants';
import { SettlementObserverService } from '@/observer/settlement-observer.service';

/**
 * The ranking itself is SQL (a window function Prisma cannot express), so these
 * pin its shape and what the sweep does with the rows it deals. The settlement
 * branches — duplicate hashes, submit races — are covered next to the domain
 * services in the swaps and liquidity-pools specs.
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
    );

    await (observer as any).reconcileSwaps(50);

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
    );

    await (observer as any).reconcileLiquidity(50);

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
    );

    await (observer as any).reconcileSwaps(50);

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
    );

    await (observer as any).reconcileSwaps(50);

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
    );

    await (observer as any).reconcileLiquidity(50);

    const text = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(text).not.toMatch(/expiresAt/);
    expect(liquidity.finalizeExpired).toHaveBeenCalledTimes(1);
    expect(liquidity.finalizeExpired).toHaveBeenCalledWith('absent');
  });
});
