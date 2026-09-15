import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { CustomersService } from '@/customers/customers.service';

describe('CustomersService.findAll', () => {
  const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;
  const query = { take: 100, skip: 0 };

  function build() {
    const customers = [
      { id: 'cus_1', name: 'Ada', account: 'GA...ADA', createdAt: new Date() },
      { id: 'cus_2', name: 'Grace', account: null, createdAt: new Date() },
    ];
    const prisma = {
      consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
      customer: {
        findMany: jest.fn().mockResolvedValue(customers),
        count: jest.fn().mockResolvedValue(137),
      },
      paymentIntent: { findMany: jest.fn() },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          account: 'GA...ADA',
          payments: 4n,
          succeeded: 2n,
          total: '25.5000000',
        },
      ]),
    };
    const service = new CustomersService(
      prisma as any,
      new ConsumerResolverService(prisma as never),
    );
    return { service, prisma, customers };
  }

  it('reports the row count, not the page size, and bounds the read', async () => {
    const { service, prisma } = build();

    const result = await service.findAll(consumer, query);

    // `total: data.length` was unpaginatable — it is `take` on every full page.
    expect(result.total).toBe(137);
    expect(result.data).toHaveLength(2);
    expect(result.take).toBe(100);
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 0 }),
    );
    expect(prisma.customer.count).toHaveBeenCalledWith({
      where: { consumerId: 'c1' },
    });
  });

  it('aggregates payment stats in Postgres instead of loading every intent', async () => {
    const { service, prisma } = build();

    const result = await service.findAll(consumer, query);

    // The old shape: every payment intent of the consumer, tallied in JS.
    expect(prisma.paymentIntent.findMany).not.toHaveBeenCalled();

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('GROUP BY');
    // `amount` is a String column, so `_sum` is unavailable and the cast is
    // what makes the money exact.
    expect(sql).toContain('::numeric');
    expect(sql).toContain(`FILTER (WHERE "status" = 'SUCCEEDED')`);
    // Parameterized, and only for the accounts on this page.
    expect(values[0]).toBe('c1');

    expect(result.data[0]).toMatchObject({
      id: 'cus_1',
      payments: 4,
      succeeded: 2,
      total: '25.5',
    });
  });

  it('reports no activity for customers without an account', async () => {
    const { service } = build();
    const result = await service.findAll(consumer, query);
    expect(result.data[1]).toMatchObject({
      id: 'cus_2',
      payments: 0,
      succeeded: 0,
      total: '0',
    });
  });

  it('skips the aggregate entirely when no customer on the page has an account', async () => {
    const { service, prisma } = build();
    prisma.customer.findMany.mockResolvedValue([
      { id: 'cus_2', name: 'Grace', account: null },
    ]);

    const result = await service.findAll(consumer, query);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(result.data[0]).toMatchObject({ payments: 0, total: '0' });
  });

  it('keeps settled volume exact rather than rounding through a float', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([
      {
        account: 'GA...ADA',
        payments: 3n,
        succeeded: 3n,
        // A sum that binary floating point cannot represent (0.1+0.2 style).
        total: '0.3000000',
      },
    ]);

    const result = await service.findAll(consumer, query);

    expect(result.data[0]).toMatchObject({ total: '0.3' });
  });
});

/**
 * A settled payment's payer lands on the merchant's customer list. The row is
 * this module's, so payment intents ask for it here rather than writing it.
 */
describe('CustomersService.ensureForPayer', () => {
  const account = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

  function build(existing: { id: string } | null) {
    const prisma = {
      customer: {
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({ id: 'cus_new' }),
      },
    };
    const service = new CustomersService(
      prisma as any,
      new ConsumerResolverService(prisma as never),
    );
    return { service, prisma };
  }

  it("adds a first-time payer to that consumer's customers, marked as automatic", async () => {
    const { service, prisma } = build(null);

    await service.ensureForPayer('c1', account);

    // Scoped to the consumer: another tenant's customer with the same account
    // is not this merchant's.
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { consumerId: 'c1', account },
      select: { id: true },
    });
    expect(prisma.customer.create).toHaveBeenCalledWith({
      data: {
        consumerId: 'c1',
        name: 'GBRPYH…OX2H',
        account,
        reference: 'auto',
      },
    });
  });

  it('leaves a payer already on the list alone, so repeat payments add no duplicate', async () => {
    const { service, prisma } = build({ id: 'cus_1' });

    await service.ensureForPayer('c1', account);

    expect(prisma.customer.create).not.toHaveBeenCalled();
  });
});
