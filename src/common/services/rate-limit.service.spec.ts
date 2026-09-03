import { RateLimitService } from '@/common/services/rate-limit.service';

const POLICY = { name: 'test', limit: 3, windowMs: 60_000 };

function makeService(counts: number[]) {
  const queryRaw = jest.fn();
  for (const count of counts) queryRaw.mockResolvedValueOnce([{ count }]);
  const prisma: any = { $queryRaw: queryRaw };
  return { service: new RateLimitService(prisma), queryRaw };
}

describe('hit', () => {
  it('allows up to the limit and refuses the one past it', async () => {
    const { service } = makeService([1, 2, 3, 4]);

    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(await service.hit('ip', POLICY));
    }

    expect(outcomes.map((o) => o.allowed)).toEqual([true, true, true, false]);
    expect(outcomes.map((o) => o.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('aligns the window to the epoch, not to first contact', async () => {
    // Every replica must compute the same boundary for the same subject without
    // talking to the others; anchoring on first contact would give each replica
    // its own window and its own budget.
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_123);
    const { service, queryRaw } = makeService([1]);

    const outcome = await service.hit('ip', POLICY);

    const windowStart = queryRaw.mock.calls[0][2] as Date;
    expect(windowStart.getTime() % POLICY.windowMs).toBe(0);
    expect(outcome.resetAt.getTime()).toBe(
      windowStart.getTime() + POLICY.windowMs,
    );
    jest.restoreAllMocks();
  });

  it('keeps the counter past the reset so a mid-flight request can still increment it', async () => {
    const { service, queryRaw } = makeService([1]);

    const outcome = await service.hit('ip', POLICY);

    // Tagged template: [0] is the string parts, then key, windowStart, expiresAt.
    const expiresAt = queryRaw.mock.calls[0][3] as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(outcome.resetAt.getTime());
  });

  it('namespaces the counter by policy so two routes cannot share a budget', async () => {
    const { service, queryRaw } = makeService([1, 1]);

    await service.hit('ip', POLICY);
    await service.hit('ip', { ...POLICY, name: 'other' });

    expect(queryRaw.mock.calls[0][1]).toBe('test:ip');
    expect(queryRaw.mock.calls[1][1]).toBe('other:ip');
  });

  it('fails closed when the counter cannot be written', async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection reset')),
    };
    const service = new RateLimitService(prisma);

    // A limiter that silently stops limiting during a database incident is
    // worth less than none, because nothing tells you it happened — and every
    // route behind this one needs the same database anyway, so refusing costs
    // no availability that was not already lost.
    await expect(service.hit('ip', POLICY)).rejects.toThrow(
      /Rate limiting is temporarily unavailable/,
    );
  });
});
