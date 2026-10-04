import { AdminExtensions } from '@/admin/admin-extensions';
import { AdminService } from '@/admin/admin.service';

function prismaFake() {
  return {
    consumer: {
      count: jest.fn().mockResolvedValue(2),
      findMany: jest.fn().mockResolvedValue([
        { id: 'c1', _count: { paymentIntents: 3 } },
        { id: 'c2', _count: { paymentIntents: 0 } },
      ]),
    },
    customer: { count: jest.fn().mockResolvedValue(0) },
    product: { count: jest.fn().mockResolvedValue(0) },
    webhookEndpoint: { count: jest.fn().mockResolvedValue(0) },
    paymentIntent: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([
        { amount: '1', asset: 'native', chain: 'stellar' },
        { amount: '2', asset: 'native', chain: 'solana' },
      ]),
    },
    swap: { groupBy: jest.fn().mockResolvedValue([]) },
    chainSwap: {
      groupBy: jest
        .fn()
        .mockResolvedValue([{ status: 'SUCCEEDED', _count: { _all: 2 } }]),
    },
    crossChainSwap: { groupBy: jest.fn().mockResolvedValue([]) },
  };
}

describe('AdminService with plugin extensions', () => {
  const fiat = {
    key: 'fiat',
    summary: jest.fn().mockResolvedValue({ receivers: { total: 1 } }),
    countsByConsumer: jest
      .fn()
      .mockResolvedValue(new Map([['c1', { payins: 4 }]])),
  };

  it('publishes each registered plugin’s section of the summary, and nothing without one', async () => {
    const bare = await new AdminService(
      prismaFake() as never,
      new AdminExtensions(),
    ).summary();
    expect(bare).not.toHaveProperty('fiat');

    const extensions = new AdminExtensions();
    extensions.register(fiat);
    const summary = await new AdminService(
      prismaFake() as never,
      extensions,
    ).summary();
    expect(summary).toMatchObject({ fiat: { receivers: { total: 1 } } });
  });

  it('keeps SOL out of XLM’s volume row', async () => {
    const summary = await new AdminService(
      prismaFake() as never,
      new AdminExtensions(),
    ).summary();
    expect(summary.volume).toEqual([
      { asset: 'XLM', amount: '1', count: 1 },
      { asset: 'solana:native', amount: '2', count: 1 },
    ]);
  });

  it('merges a plugin’s per-consumer counts into `_count`', async () => {
    const extensions = new AdminExtensions();
    extensions.register(fiat);
    const page = await new AdminService(
      prismaFake() as never,
      extensions,
    ).consumers();
    expect(fiat.countsByConsumer).toHaveBeenCalledWith(['c1', 'c2']);
    expect(page.data[0]._count).toEqual({ paymentIntents: 3, payins: 4 });
    expect(page.data[1]._count).toEqual({ paymentIntents: 0 });
  });

  it('refuses two plugins claiming the same section', () => {
    const extensions = new AdminExtensions();
    extensions.register(fiat);
    expect(() => extensions.register(fiat)).toThrow(/registered twice/);
  });
});

describe('AdminService — Solana/Monad and cross-chain swaps', () => {
  it('counts them in the summary beside the Stellar swaps', async () => {
    const summary = await new AdminService(
      prismaFake() as never,
      new AdminExtensions(),
    ).summary();
    expect(summary.chainSwaps).toEqual({
      total: 2,
      byStatus: { SUCCEEDED: 2 },
    });
    expect(summary.crossChainSwaps).toEqual({ total: 0, byStatus: {} });
  });

  it('lists them across consumers, filtered, without the raw quote', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      chainSwap: { findMany, count },
      crossChainSwap: { findMany, count },
    };
    const admin = new AdminService(prisma as never, new AdminExtensions());

    await admin.chainSwaps({ chain: 'monad', status: 'SUCCEEDED', take: 10 });
    await admin.crossChainSwaps({ consumer: 'c1' });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { chain: 'monad', status: 'SUCCEEDED' },
      take: 10,
      omit: { quote: true },
    });
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { consumerId: 'c1' },
      omit: { quote: true },
    });
  });
});
