import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  CUSTOMER_PUBLIC_SELECT,
  CustomersService,
} from '@/customers/customers.service';

// Mirrors the real config: a key with no environment falls back to this network.
const config = { get: () => ({ network: 'testnet' }) };

describe('CustomersService responses', () => {
  const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;
  const stored = {
    id: 'cus_1',
    consumerId: 'c_internal',
    name: 'Ada',
    alias: null,
    email: null,
    account: null,
    note: null,
    reference: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function build() {
    const prisma = {
      consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
      customer: {
        create: jest.fn().mockResolvedValue(stored),
        findFirst: jest.fn().mockResolvedValue(stored),
        findMany: jest.fn().mockResolvedValue([stored]),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue(stored),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new CustomersService(
      prisma as any,
      new ConsumerResolverService(prisma as never),
      config as never,
    );
    return { service, prisma };
  }

  it('reads, creates and updates through the public projection', async () => {
    const { service, prisma } = build();

    await service.create(consumer, { name: 'Ada' });
    await service.findAll(consumer, { take: 20, skip: 0 });
    await service.findOne(consumer, 'cus_1');
    await service.update(consumer, 'cus_1', { note: 'vip' });

    // Every one of these answered with the full row, consumerId included.
    const projected = expect.objectContaining({
      select: CUSTOMER_PUBLIC_SELECT,
    });
    expect(prisma.customer.create).toHaveBeenCalledWith(projected);
    expect(prisma.customer.findMany).toHaveBeenCalledWith(projected);
    expect(prisma.customer.findFirst).toHaveBeenCalledWith(projected);
    expect(prisma.customer.update).toHaveBeenCalledWith(projected);
    expect(CUSTOMER_PUBLIC_SELECT).not.toHaveProperty('consumerId');
  });
});

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
      config as never,
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
      config as never,
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

/**
 * A customer's account may be on any chain the service settles. It is stored in its chain's
 * spelling, so the stats find the payer a payment intent recorded, whatever its chain, on the
 * network the caller's key targets.
 */
describe('CustomersService accounts on every chain', () => {
  const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
  const SOLANA = 'So11111111111111111111111111111111111111112';
  const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const consumer = {
    username: 'cosmos_u1',
    credentialId: 'cred_1',
    environment: 'prod',
  } as any;

  function build(customers: { id: string; account: string | null }[] = []) {
    const prisma = {
      consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
      customer: {
        create: jest.fn().mockResolvedValue({ id: 'cus_1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'cus_1' }),
        update: jest.fn().mockResolvedValue({ id: 'cus_1' }),
        findMany: jest.fn().mockResolvedValue(customers),
        count: jest.fn().mockResolvedValue(customers.length),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new CustomersService(
      prisma as any,
      new ConsumerResolverService(prisma as never),
      config as never,
    );
    return { service, prisma };
  }

  it.each([
    ['Stellar', STELLAR, STELLAR],
    ['Solana', SOLANA, SOLANA],
    ['Monad (EIP-55, whatever case it came in)', MONAD.toLowerCase(), MONAD],
  ])('stores a %s account in its chain’s spelling', async (_, sent, stored) => {
    const { service, prisma } = build();

    await service.create(consumer, { name: 'Ada', account: sent });
    await service.update(consumer, 'cus_1', { account: sent });

    expect(prisma.customer.create.mock.calls[0][0].data.account).toBe(stored);
    expect(prisma.customer.update.mock.calls[0][0].data).toEqual({
      account: stored,
    });
  });

  it('clears the account on null and leaves it alone when the update omits it', async () => {
    const { service, prisma } = build();

    await service.update(consumer, 'cus_1', { account: null as never });
    await service.update(consumer, 'cus_1', { note: 'vip' });

    expect(prisma.customer.update.mock.calls[0][0].data).toEqual({
      account: null,
    });
    expect(prisma.customer.update.mock.calls[1][0].data).toEqual({
      note: 'vip',
    });
  });

  it('matches payments on every chain by payer, never by chain, on the key’s network', async () => {
    const { service, prisma } = build([
      { id: 'cus_s', account: STELLAR },
      { id: 'cus_o', account: SOLANA },
      { id: 'cus_m', account: MONAD },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      { account: SOLANA, payments: 1n, succeeded: 1n, total: '0.25' },
      { account: MONAD, payments: 2n, succeeded: 1n, total: '3.5' },
    ]);

    const result = await service.findAll(consumer, { take: 100, skip: 0 });

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('"network" = ?');
    expect(sql).toContain('"source" IN (?)');
    expect(sql).not.toContain('"chain"');
    expect(values[0]).toBe('c1');
    expect(values[1]).toBe('public');
    expect((values[2] as { values: unknown[] }).values).toEqual([
      STELLAR,
      SOLANA,
      MONAD,
    ]);
    expect(result.data.map((c) => [c.id, c.payments, c.total])).toEqual([
      ['cus_s', 0, '0'],
      ['cus_o', 1, '0.25'],
      ['cus_m', 2, '3.5'],
    ]);
  });

  it('counts a sandbox key’s customers on testnet only', async () => {
    const { service, prisma } = build([{ id: 'cus_s', account: STELLAR }]);

    await service.findAll(
      { ...consumer, environment: 'dev' },
      { take: 100, skip: 0 },
    );

    expect(prisma.$queryRaw.mock.calls[0][2]).toBe('testnet');
  });
});
