import { PollarWalletProvisionSweeperService } from '@/pollar/wallets/pollar-wallet-provision-sweeper.service';

function build(sweep = { enabled: true, intervalMs: 60_000 }) {
  const prisma = {
    pollarUserWallet: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const config = { get: () => ({ sweep }) } as any;
  const provisioning = { attempt: jest.fn().mockResolvedValue({}) } as any;
  // The real lock runs `work` only on the replica that wins it; here it always
  // wins, so these tests exercise the sweep itself.
  const locks = {
    runExclusive: jest.fn((_key: number, work: () => Promise<unknown>) =>
      work(),
    ),
  } as any;
  const service = new PollarWalletProvisionSweeperService(
    prisma as any,
    config,
    provisioning,
    locks,
  );
  return { service, prisma, provisioning, locks };
}

describe('schedule', () => {
  it('shares the handshake sweeper switch and interval', () => {
    expect(
      build({ enabled: false, intervalMs: 5000 }).service['schedule'](),
    ).toMatchObject({ enabled: false, intervalMs: 5000 });
  });
});

describe('cycle', () => {
  it('claims only pending rows whose backoff has elapsed', async () => {
    const { service, prisma } = build();

    await service.tick();

    const call = prisma.pollarUserWallet.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('PENDING');
    // A row a redemption just wrote has no deadline yet; one that failed has a
    // future one. Both shapes have to be covered or the sweep drains nothing.
    expect(call.where.OR).toEqual([
      { nextAttemptAt: null },
      { nextAttemptAt: { lte: expect.any(Date) } },
    ]);
    expect(call.orderBy).toEqual({ createdAt: 'asc' });
    expect(call.take).toBeGreaterThan(0);
  });

  it('stamps the claim so another replica cannot pick up the same row', async () => {
    const { service, prisma } = build();
    prisma.pollarUserWallet.findMany
      .mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }])
      .mockResolvedValueOnce([]);

    await service.tick();

    // Pushing the deadline forward is what makes releasing the lock before the
    // Pollar calls safe.
    const stamp = prisma.pollarUserWallet.updateMany.mock.calls[0][0];
    expect(stamp.where.id.in).toEqual(['w1', 'w2']);
    expect(stamp.data.nextAttemptAt).toBeInstanceOf(Date);
    expect(stamp.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('holds the lock over the claim only, not the provider calls', async () => {
    const { service, locks, provisioning, prisma } = build();
    prisma.pollarUserWallet.findMany
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockResolvedValueOnce([{ id: 'w1', network: 'public' }]);

    await service.tick();

    // One unresponsive provider must not stall every replica's sweep.
    expect(locks.runExclusive).toHaveBeenCalledTimes(1);
    expect(provisioning.attempt).toHaveBeenCalledTimes(1);
  });

  it('retries each claimed row', async () => {
    const { service, prisma, provisioning } = build();
    const rows = [
      { id: 'w1', network: 'public' },
      { id: 'w2', network: 'testnet' },
    ];
    prisma.pollarUserWallet.findMany
      .mockResolvedValueOnce(rows.map((r) => ({ id: r.id })))
      .mockResolvedValueOnce(rows);

    await service.tick();

    expect(provisioning.attempt).toHaveBeenCalledTimes(2);
    expect(provisioning.attempt.mock.calls.map((c: any[]) => c[0])).toEqual(
      rows,
    );
  });

  it('keeps draining the batch when one row throws', async () => {
    const { service, prisma, provisioning } = build();
    const rows = [
      { id: 'w1', network: 'public' },
      { id: 'w2', network: 'testnet' },
    ];
    prisma.pollarUserWallet.findMany
      .mockResolvedValueOnce(rows.map((r) => ({ id: r.id })))
      .mockResolvedValueOnce(rows);
    provisioning.attempt.mockRejectedValueOnce(new Error('db down'));

    await expect(service.tick()).resolves.toBeUndefined();
    expect(provisioning.attempt).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when nothing is due', async () => {
    const { service, prisma, provisioning } = build();
    await service.tick();
    expect(prisma.pollarUserWallet.updateMany).not.toHaveBeenCalled();
    expect(provisioning.attempt).not.toHaveBeenCalled();
  });

  it('swallows a failed cycle so the timer survives it', async () => {
    const { service, prisma } = build();
    prisma.pollarUserWallet.findMany.mockRejectedValue(new Error('db down'));

    // `tick` is called as `void this.tick()` from a setInterval, so anything
    // escaping it is an unhandled rejection.
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
