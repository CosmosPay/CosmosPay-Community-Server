import { PollarOauthSweeperService } from '@/pollar/oauth/pollar-oauth-sweeper.service';

function build(sweep = { enabled: true, intervalMs: 60_000 }) {
  const prisma = {
    pollarOauthSession: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const config = { get: () => ({ sweep }) } as any;
  // The real lock runs `work` only on the replica that wins the advisory lock;
  // here it always wins, so these tests exercise the sweep itself.
  const locks = {
    runExclusive: jest.fn((_key: number, work: () => Promise<unknown>) =>
      work(),
    ),
  } as any;
  const service = new PollarOauthSweeperService(prisma as any, config, locks);
  return { service, prisma, locks };
}

describe('schedule', () => {
  it('follows the configured switch and interval', () => {
    expect(
      build({ enabled: false, intervalMs: 5000 }).service['schedule'](),
    ).toMatchObject({ enabled: false, intervalMs: 5000 });
  });
});

describe('run', () => {
  it('sweeps the three non-terminal states, oldest first', async () => {
    const { service, prisma } = build();

    await service.tick();

    const where = prisma.pollarOauthSession.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['PENDING', 'AUTHORIZED', 'EXCHANGING']);
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    expect(prisma.pollarOauthSession.findMany.mock.calls[0][0].orderBy).toEqual(
      { expiresAt: 'asc' },
    );
  });

  it('includes EXCHANGING, which only a crashed replica can leave behind', async () => {
    // `releaseOrFail` runs in the process that was redeeming; if that process
    // died, nothing else ever moves the row and it would be stuck forever.
    const { service, prisma } = build();
    await service.tick();
    expect(
      prisma.pollarOauthSession.findMany.mock.calls[0][0].where.status.in,
    ).toContain('EXCHANGING');
  });

  it('clears the code hash, which is the point of the sweep', async () => {
    const { service, prisma } = build();
    prisma.pollarOauthSession.findMany.mockResolvedValue([
      { id: 's1' },
      { id: 's2' },
    ]);
    prisma.pollarOauthSession.updateMany.mockResolvedValue({ count: 2 });

    await service.tick();

    const call = prisma.pollarOauthSession.updateMany.mock.calls[0][0];
    expect(call.where.id.in).toEqual(['s1', 's2']);
    // While the hash is set, the row IS a redeemable code.
    expect(call.data).toMatchObject({
      status: 'EXPIRED',
      codeHash: null,
      codeExpiresAt: null,
    });
  });

  it('writes nothing when there is nothing stale', async () => {
    const { service, prisma } = build();
    await service.tick();
    expect(prisma.pollarOauthSession.updateMany).not.toHaveBeenCalled();
  });

  it('bounds each tick', async () => {
    const { service, prisma } = build();
    await service.tick();
    expect(
      prisma.pollarOauthSession.findMany.mock.calls[0][0].take,
    ).toBeGreaterThan(0);
  });

  it('swallows a failed cycle so the timer survives it', async () => {
    const { service, prisma } = build();
    prisma.pollarOauthSession.findMany.mockRejectedValue(new Error('db down'));

    // `tick` is called as `void this.tick()` from a setInterval, so anything
    // escaping it is an unhandled rejection — which under Node's default policy
    // kills a process mid-payment.
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
