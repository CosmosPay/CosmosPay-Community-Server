import { AliasChallengeSweeperService } from '@/aliases/alias-challenge-sweeper.service';
import {
  ALIAS_SWEEP_BATCH_SIZE,
  ALIAS_SWEEP_GRACE_MS,
} from '@/aliases/aliases.constants';
import { AdvisoryLockKey } from '@/common/services/advisory-lock.service';

function ids(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}` }));
}

function build() {
  const prisma = {
    aliasChallenge: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: where.id.in.length }),
      ),
    },
    aliasRecovery: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: where.id.in.length }),
      ),
    },
  };
  const locks = {
    runExclusive: jest.fn((_key: AdvisoryLockKey, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const sweeper = new AliasChallengeSweeperService(
    prisma as never,
    locks as never,
  );
  return { sweeper, prisma, locks };
}

describe('AliasChallengeSweeperService', () => {
  it('runs under its own advisory lock, so one replica sweeps per tick', async () => {
    const { sweeper, locks } = build();
    await sweeper.tick();
    expect(locks.runExclusive).toHaveBeenCalledWith(
      AdvisoryLockKey.AliasChallengeSweeper,
      expect.any(Function),
    );
  });

  it('only selects rows that expired before the grace cutoff', async () => {
    const { sweeper, prisma } = build();
    const before = Date.now();
    await sweeper.tick();

    for (const delegate of [prisma.aliasChallenge, prisma.aliasRecovery]) {
      const cutoff: Date =
        delegate.findMany.mock.calls[0][0].where.expiresAt.lt;
      // A just-expired row survives the grace period; nothing live is touched.
      expect(cutoff.getTime()).toBeLessThanOrEqual(
        before - ALIAS_SWEEP_GRACE_MS + 1000,
      );
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(
        before - ALIAS_SWEEP_GRACE_MS - 1000,
      );
    }
  });

  it('deletes exactly the ids it selected, page by page, until a short page', async () => {
    const { sweeper, prisma } = build();
    prisma.aliasChallenge.findMany
      .mockResolvedValueOnce(ids(ALIAS_SWEEP_BATCH_SIZE, 'ch'))
      .mockResolvedValueOnce(ids(3, 'ch2'));
    prisma.aliasRecovery.findMany.mockResolvedValueOnce(ids(2, 'rec'));

    await sweeper.tick();

    expect(prisma.aliasChallenge.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.aliasChallenge.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.aliasChallenge.deleteMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['ch2_0', 'ch2_1', 'ch2_2'] } },
    });
    expect(prisma.aliasRecovery.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['rec_0', 'rec_1'] } },
    });
  });

  it('issues no delete when nothing has expired', async () => {
    const { sweeper, prisma } = build();
    await sweeper.tick();
    expect(prisma.aliasChallenge.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aliasRecovery.deleteMany).not.toHaveBeenCalled();
  });

  it('stops at a full page that deleted nothing only when the cap is reached, not forever', async () => {
    // A sibling replica may have deleted the page first (count 0). The loop is
    // bounded by rows examined, so it still terminates.
    const { sweeper, prisma } = build();
    prisma.aliasChallenge.findMany.mockResolvedValue(
      ids(ALIAS_SWEEP_BATCH_SIZE, 'ch'),
    );
    prisma.aliasChallenge.deleteMany.mockResolvedValue({ count: 0 });

    await sweeper.tick();

    expect(prisma.aliasChallenge.findMany.mock.calls.length).toBeLessThan(1000);
  });
});
