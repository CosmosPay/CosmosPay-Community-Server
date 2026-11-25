import { AdvisoryLockKey } from '@/common/services/advisory-lock.service';
import {
  P2P_DIRECT_PROCESSING_SWEEP_BATCH,
  P2P_DIRECT_PROCESSING_SWEEP_INTERVAL_MS,
} from '@/native-plugins/eldorado/eldorado.constants';
import { P2pDirectProcessingSweepService } from '@/native-plugins/eldorado/p2p-direct-processing-sweep.service';

function setup(observer = true) {
  const ledger = { reopenOverdue: jest.fn(() => Promise.resolve([])) };
  const locks = {
    runExclusive: jest.fn((_key: number, work: () => Promise<void>) => work()),
  };
  const config = { get: jest.fn(() => ({ enabled: observer })) };
  const sweep = new P2pDirectProcessingSweepService(
    config as never,
    ledger as never,
    locks as never,
  );
  return { sweep, ledger, locks, config };
}

describe('P2pDirectProcessingSweepService', () => {
  it('reopens the overdue requests, a batch per cycle, under its own lock', async () => {
    const { sweep, ledger, locks } = setup();

    await sweep.tick();

    expect(locks.runExclusive.mock.calls[0][0]).toBe(
      AdvisoryLockKey.P2pDirectProcessingSweep,
    );
    expect(ledger.reopenOverdue).toHaveBeenCalledWith(
      expect.any(Date),
      P2P_DIRECT_PROCESSING_SWEEP_BATCH,
    );
  });

  it('runs with the settlement observer', () => {
    const schedule = (observer: boolean) =>
      (
        setup(observer).sweep as unknown as {
          schedule(): { enabled: boolean; intervalMs: number };
        }
      ).schedule();

    expect(schedule(true)).toMatchObject({
      enabled: true,
      intervalMs: P2P_DIRECT_PROCESSING_SWEEP_INTERVAL_MS,
    });
    expect(schedule(false).enabled).toBe(false);
  });
});
