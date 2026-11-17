import { PaymentDepositObserverService } from '@/payment-intents/payment-deposit-observer.service';
import { SandboxDepositObserverService } from '@/payment-intents/sandbox-deposit-observer.service';

/**
 * Each tier has its own observer: a sandbox deposit (stored on its link's tier,
 * `testnet`) is followed only by the sandbox observer, a mainnet one only by the
 * route's. Both read one in-memory table that honours `where.network`, as
 * Postgres would.
 */
describe('deposit tiers', () => {
  const ROWS = [
    { id: 'dep_main', network: 'public', status: 'AWAITING_DEPOSIT' },
    { id: 'dep_sandbox', network: 'testnet', status: 'AWAITING_DEPOSIT' },
  ];
  const lock = {
    runExclusive: jest.fn((_key: unknown, work: () => Promise<unknown>) =>
      work(),
    ),
  } as never;
  const config = {
    get: (key: string) =>
      key === 'observer'
        ? { enabled: true, intervalMs: 15_000 }
        : { timeoutMs: 1000 },
  } as never;
  const table = () => ({
    paymentDeposit: {
      findMany: jest.fn(({ where }: { where: { network?: string } }) =>
        Promise.resolve(
          ROWS.filter((r) => !where.network || r.network === where.network),
        ),
      ),
    },
  });

  it('the route observer follows mainnet deposits only', async () => {
    const prisma = table();
    const nearIntents = { status: jest.fn().mockResolvedValue(null) };
    const deposits = {
      applyProviderStatus: jest.fn().mockResolvedValue({}),
      settle: jest.fn().mockResolvedValue(undefined),
    };
    const observer = new PaymentDepositObserverService(
      config,
      prisma as never,
      nearIntents as never,
      deposits as never,
      lock,
    );
    await observer.tick();
    const seen = [
      ...nearIntents.status.mock.calls,
      ...deposits.settle.mock.calls,
    ].flat();
    expect(JSON.stringify(seen)).not.toContain('dep_sandbox');
    for (const [query] of prisma.paymentDeposit.findMany.mock.calls) {
      expect(query.where.network).toBe('public');
    }
  });

  it('the sandbox observer follows test-network deposits only', async () => {
    const prisma = table();
    const settler = {
      observe: jest.fn((d: { id: string }) =>
        Promise.resolve({
          correlationId: d.id,
          status: 'PROCESSING',
          updatedAt: '',
        }),
      ),
    };
    const deposits = { applyProviderStatus: jest.fn().mockResolvedValue({}) };
    const observer = new SandboxDepositObserverService(
      config,
      prisma as never,
      { isConfigured: () => true } as never,
      settler as never,
      deposits as never,
      lock,
    );
    await observer.tick();
    expect(settler.observe.mock.calls.map(([d]) => d.id)).toEqual([
      'dep_sandbox',
    ]);
  });
});
