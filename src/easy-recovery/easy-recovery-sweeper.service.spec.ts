import { Logger } from '@nestjs/common';
import { AdvisoryLockKey } from '@/common/services/advisory-lock.service';
import { EasyRecoverySweeperService } from '@/easy-recovery/easy-recovery-sweeper.service';
import {
  EASY_RECOVERY_SWEEP_BATCH_SIZE,
  EASY_RECOVERY_SWEEP_MAX_PER_CYCLE,
} from '@/easy-recovery/easy-recovery.constants';

function ids(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}` }));
}

function build(sweep = { enabled: true, intervalMs: 60_000 }) {
  const prisma = {
    easyRecoverySession: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: where.id.in.length }),
      ),
    },
  };
  const config = { get: jest.fn(() => ({ sweep })) };
  const locks = {
    runExclusive: jest.fn((_key: AdvisoryLockKey, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const sweeper = new EasyRecoverySweeperService(
    prisma as never,
    config as never,
    locks as never,
  );
  return { sweeper, prisma, config, locks };
}

describe('EasyRecoverySweeperService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs under its own advisory lock, so one replica sweeps per tick', async () => {
    const { sweeper, locks } = build();
    await sweeper.tick();
    expect(locks.runExclusive).toHaveBeenCalledWith(
      AdvisoryLockKey.EasyRecoverySweeper,
      expect.any(Function),
    );
  });

  it('runs on the wallet sign-in sweep schedule', () => {
    const { sweeper, config } = build({ enabled: false, intervalMs: 5_000 });
    // Disabled by the same switch: no timer is started.
    const setInterval = jest.spyOn(global, 'setInterval');
    sweeper.onModuleInit();
    expect(config.get).toHaveBeenCalledWith('walletAuth', { infer: true });
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('deletes only sessions already past their expiry, with no grace', async () => {
    const { sweeper, prisma } = build();
    prisma.easyRecoverySession.findMany.mockResolvedValueOnce(ids(2, 'er'));
    const before = Date.now();

    await sweeper.tick();

    const cutoff: Date =
      prisma.easyRecoverySession.findMany.mock.calls[0][0].where.expiresAt.lt;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
    expect(prisma.easyRecoverySession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['er_0', 'er_1'] }, expiresAt: { lt: cutoff } },
    });
  });

  it('drains page by page until a short page', async () => {
    const { sweeper, prisma } = build();
    prisma.easyRecoverySession.findMany
      .mockResolvedValueOnce(ids(EASY_RECOVERY_SWEEP_BATCH_SIZE, 'a'))
      .mockResolvedValueOnce(ids(3, 'b'));

    await sweeper.tick();

    expect(prisma.easyRecoverySession.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.easyRecoverySession.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('issues no delete when nothing has expired', async () => {
    const { sweeper, prisma } = build();
    await sweeper.tick();
    expect(prisma.easyRecoverySession.deleteMany).not.toHaveBeenCalled();
  });

  it('ends a cycle at its cap even when another replica keeps winning the delete', async () => {
    const { sweeper, prisma } = build();
    prisma.easyRecoverySession.findMany.mockResolvedValue(
      ids(EASY_RECOVERY_SWEEP_BATCH_SIZE, 'x'),
    );
    prisma.easyRecoverySession.deleteMany.mockResolvedValue({ count: 0 });

    await sweeper.tick();

    expect(prisma.easyRecoverySession.findMany).toHaveBeenCalledTimes(
      EASY_RECOVERY_SWEEP_MAX_PER_CYCLE / EASY_RECOVERY_SWEEP_BATCH_SIZE,
    );
  });
});
