import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { ProductsService } from '@/products/products.service';

describe('ProductsService.findAll', () => {
  const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;

  function build() {
    const prisma = {
      consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
      product: {
        findMany: jest.fn().mockResolvedValue([{ id: 'prod_1' }]),
        count: jest.fn().mockResolvedValue(42),
      },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    };
    const service = new ProductsService(
      prisma as any,
      new ConsumerResolverService(prisma as never),
    );
    return { service, prisma };
  }

  it('reports the row count, not the page size', async () => {
    const { service, prisma } = build();

    const result = await service.findAll(consumer, { take: 100, skip: 0 });

    // `total: data.length` told a client nothing: on every full page it is
    // just `take`, so there was no way to know whether more rows existed.
    expect(result).toEqual({
      data: [{ id: 'prod_1' }],
      total: 42,
      take: 100,
      skip: 0,
    });
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: { consumerId: 'c1' },
    });
  });

  it('bounds the read with the requested page', async () => {
    const { service, prisma } = build();

    await service.findAll(consumer, { take: 25, skip: 50 });

    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { consumerId: 'c1' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      skip: 50,
    });
  });
});
