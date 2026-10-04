import { ConfigService } from '@nestjs/config';
import type { AdvisoryLockService } from '@/common/services/advisory-lock.service';
import { CrossChainSwapObserverService } from '@/cross-chain-swaps/cross-chain-swap-observer.service';
import type { CrossChainSwapsService } from '@/cross-chain-swaps/cross-chain-swaps.service';
import type { NearIntentsClient } from '@/near-intents/near-intents.client';
import type { PrismaService } from '@/prisma/prisma.service';

function setup(rows: any[]) {
  const cfg: Record<string, unknown> = {
    observer: { enabled: true, intervalMs: 15_000 },
    nearIntents: { timeoutMs: 5000 },
  };
  const config = {
    get: (key: string) => cfg[key],
  } as unknown as ConfigService<any, true>;
  const prisma = {
    crossChainSwap: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const nearIntents = { status: jest.fn() };
  const swaps = { applyProviderStatus: jest.fn().mockResolvedValue({}) };
  const locks = {
    runExclusive: jest.fn((_key: unknown, work: () => Promise<unknown>) =>
      work(),
    ),
  };
  const observer = new CrossChainSwapObserverService(
    config,
    prisma as unknown as PrismaService,
    nearIntents as unknown as NearIntentsClient,
    swaps as unknown as CrossChainSwapsService,
    locks as unknown as AdvisoryLockService,
  );
  return { observer, prisma, nearIntents, swaps };
}

const row = (id: string) => ({
  id,
  status: 'AWAITING_DEPOSIT',
  depositAddress: `addr_${id}`,
  depositMemo: id === 'a' ? '42' : null,
  consumer: { apisixUsername: 'cosmos_u1' },
});

describe('CrossChainSwapObserverService', () => {
  it('asks 1Click about each open swap and hands the answer on, without the join', async () => {
    const { observer, nearIntents, swaps } = setup([row('a'), row('b')]);
    nearIntents.status.mockResolvedValue({ status: 'PROCESSING' });

    await observer.tick();

    expect(nearIntents.status).toHaveBeenCalledWith('addr_a', '42');
    expect(nearIntents.status).toHaveBeenCalledWith('addr_b', null);
    expect(swaps.applyProviderStatus).toHaveBeenCalledTimes(2);
    const [swap, status, username] = swaps.applyProviderStatus.mock.calls[0];
    expect(swap).not.toHaveProperty('consumer');
    expect(status).toEqual({ status: 'PROCESSING' });
    expect(username).toBe('cosmos_u1');
  });

  it('polls open swaps and recently EXPIRED ones, least recently checked first', async () => {
    const { observer, prisma } = setup([]);
    await observer.tick();

    const query = prisma.crossChainSwap.findMany.mock.calls[0][0];
    expect(query.where.OR[0].status.in).toEqual([
      'AWAITING_DEPOSIT',
      'DEPOSIT_DETECTED',
      'INCOMPLETE_DEPOSIT',
      'PROCESSING',
    ]);
    expect(query.where.OR[1].status).toBe('EXPIRED');
    expect(query.orderBy).toEqual([
      { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
    ]);
  });

  it('keeps going when one swap fails', async () => {
    const { observer, nearIntents, swaps } = setup([row('a'), row('b')]);
    nearIntents.status
      .mockRejectedValueOnce(new Error('1Click down'))
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    await observer.tick();

    expect(swaps.applyProviderStatus).toHaveBeenCalledTimes(1);
    expect(swaps.applyProviderStatus.mock.calls[0][0].id).toBe('b');
  });
});
