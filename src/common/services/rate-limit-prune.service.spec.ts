import { RateLimitPruneService } from '@/common/services/rate-limit-prune.service';

function build(rateLimit = { enabled: true, pruneIntervalMs: 600_000 }) {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(0) };
  const config = { get: () => rateLimit } as any;
  const locks = {
    runExclusive: jest.fn((_key: number, work: () => Promise<unknown>) =>
      work(),
    ),
  } as any;
  return {
    service: new RateLimitPruneService(prisma as any, config, locks),
    prisma,
    locks,
  };
}

describe('schedule', () => {
  it('rides on the limiter switch — nothing writes counters when it is off', () => {
    expect(
      build({ enabled: false, pruneIntervalMs: 600_000 }).service['schedule'](),
    ).toMatchObject({ enabled: false });
  });

  it('uses the configured interval', () => {
    expect(
      build({ enabled: true, pruneIntervalMs: 1234 }).service['schedule'](),
    ).toMatchObject({ enabled: true, intervalMs: 1234 });
  });
});

describe('run', () => {
  it('deletes through a bounded ctid sub-select', async () => {
    const { service, prisma } = build();

    await service.tick();

    // Tagged template: [0] is the SQL parts, then the cutoff and the batch cap.
    const [parts, cutoff, limit] = prisma.$executeRaw.mock.calls[0];
    expect(parts.join('?')).toContain('ctid IN');
    expect(cutoff).toBeInstanceOf(Date);
    expect(limit).toBeGreaterThan(0);
  });

  it('takes the advisory lock so one replica prunes per tick', async () => {
    const { service, locks } = build();
    await service.tick();
    expect(locks.runExclusive).toHaveBeenCalled();
  });

  it('swallows a failed cycle so the timer survives it', async () => {
    const { service, prisma } = build();
    prisma.$executeRaw.mockRejectedValue(new Error('db down'));
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
