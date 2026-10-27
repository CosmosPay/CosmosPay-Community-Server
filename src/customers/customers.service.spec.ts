import { ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  CUSTOMER_PUBLIC_SELECT,
  CustomersService,
} from '@/customers/customers.service';

// Mirrors the real config: a key with no environment falls back to this network.
const config = { get: () => ({ network: 'testnet' }) };

const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

const wallet = (id: string, chain: string, address: string) => ({
  id,
  chain,
  address,
  label: null,
  createdAt: new Date(),
});

const row = (id: string, wallets: ReturnType<typeof wallet>[] = []) => ({
  id,
  name: 'Ada',
  alias: null,
  email: null,
  note: null,
  reference: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  wallets,
});

/** A Prisma double over one consumer's customers and wallets. */
function build(customers: ReturnType<typeof row>[] = [row('cus_1')]) {
  const prisma = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    customer: {
      create: jest.fn(({ data }) =>
        Promise.resolve(
          row(
            'cus_new',
            (data.wallets?.create ?? []).map(
              (w: { chain: string; address: string }, i: number) =>
                wallet(`w${i}`, w.chain, w.address),
            ),
          ),
        ),
      ),
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(customers.find((c) => c.id === where.id) ?? null),
      ),
      findMany: jest.fn().mockResolvedValue(customers),
      count: jest.fn().mockResolvedValue(customers.length),
      update: jest.fn(({ where }) =>
        Promise.resolve(customers.find((c) => c.id === where.id)),
      ),
      delete: jest.fn().mockResolvedValue({}),
    },
    customerWallet: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) =>
        Promise.resolve(wallet('w_new', data.chain, data.address)),
      ),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    paymentIntent: { findMany: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const service = new CustomersService(
    prisma as any,
    new ConsumerResolverService(prisma as never),
    config as never,
  );
  return { service, prisma };
}

const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;
const prod = { ...consumer, environment: 'prod' };

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: {
      getStatus(): number;
      getResponse(): { code: string; message: string };
    }) => ({
      status: e.getStatus(),
      ...e.getResponse(),
    }),
  );

describe('CustomersService responses', () => {
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
    expect(CUSTOMER_PUBLIC_SELECT.wallets.select).not.toHaveProperty(
      'consumerId',
    );
  });

  it('answers `account` as the first wallet’s address, for clients written before wallets', async () => {
    const { service } = build([
      row('cus_1', [
        wallet('w1', 'solana', SOLANA),
        wallet('w2', 'stellar', STELLAR),
      ]),
      row('cus_2'),
    ]);

    await expect(service.findOne(consumer, 'cus_1')).resolves.toMatchObject({
      account: SOLANA,
      wallets: [{ address: SOLANA }, { address: STELLAR }],
    });
    await expect(service.findOne(consumer, 'cus_2')).resolves.toMatchObject({
      account: null,
      wallets: [],
    });
  });

  it('answers a customer of another consumer as missing (404)', async () => {
    const { service, prisma } = build();
    await expect(
      refusal(service.findOne(consumer, 'cus_other')),
    ).resolves.toMatchObject({ status: 404 });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cus_other', consumerId: 'c1' } }),
    );
  });
});

describe('CustomersService.findAll', () => {
  const query = { take: 100, skip: 0 };

  it('reports the row count, not the page size, and bounds the read', async () => {
    const { service, prisma } = build([row('cus_1'), row('cus_2')]);
    prisma.customer.count.mockResolvedValue(137);

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

  it('adds up every wallet of a customer in Postgres, on each wallet’s own chain', async () => {
    const { service, prisma } = build([
      row('cus_1', [
        wallet('w1', 'stellar', STELLAR),
        wallet('w2', 'monad', MONAD),
      ]),
      row('cus_2'),
    ]);
    prisma.$queryRaw.mockResolvedValue([
      { customer: 'cus_1', payments: 4n, succeeded: 2n, total: '25.5000000' },
    ]);

    const result = await service.findAll(prod, query);

    // The old shape: every payment intent of the consumer, tallied in JS.
    expect(prisma.paymentIntent.findMany).not.toHaveBeenCalled();
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('GROUP BY w."customerId"');
    // `amount` is a String column, so `_sum` is unavailable and the cast is
    // what makes the money exact.
    expect(sql).toContain('::numeric');
    expect(sql).toContain('p."chain" = w."chain"');
    expect(sql).toContain('p."source" = w."address"');
    // Parameterized: the consumer, the customers on this page with a wallet, the key's network.
    expect(values[0]).toBe('c1');
    expect((values[1] as { values: unknown[] }).values).toEqual(['cus_1']);
    expect(values[2]).toBe('public');

    expect(
      result.data.map((c) => [c.id, c.payments, c.succeeded, c.total]),
    ).toEqual([
      ['cus_1', 4, 2, '25.5'],
      ['cus_2', 0, 0, '0'],
    ]);
  });

  it('skips the aggregate entirely when no customer on the page has a wallet', async () => {
    const { service, prisma } = build([row('cus_2')]);

    const result = await service.findAll(consumer, query);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(result.data[0]).toMatchObject({ payments: 0, total: '0' });
  });

  it('counts a sandbox key’s customers on testnet only', async () => {
    const { service, prisma } = build([
      row('cus_1', [wallet('w1', 'stellar', STELLAR)]),
    ]);

    await service.findAll({ ...prod, environment: 'dev' }, query);

    expect(prisma.$queryRaw.mock.calls[0][3]).toBe('testnet');
  });

  it('keeps settled volume exact rather than rounding through a float', async () => {
    const { service, prisma } = build([
      row('cus_1', [wallet('w1', 'stellar', STELLAR)]),
    ]);
    prisma.$queryRaw.mockResolvedValue([
      // A sum that binary floating point cannot represent (0.1+0.2 style).
      { customer: 'cus_1', payments: 3n, succeeded: 3n, total: '0.3000000' },
    ]);

    const result = await service.findAll(consumer, query);

    expect(result.data[0]).toMatchObject({ total: '0.3' });
  });
});

describe('CustomersService.create', () => {
  it('stores every wallet in its chain’s spelling, the deprecated account as one more', async () => {
    const { service, prisma } = build();

    const created = await service.create(consumer, {
      name: 'Ada',
      wallets: [
        { chain: 'monad', address: MONAD.toLowerCase(), label: ' Rabby ' },
        { chain: 'solana', address: SOLANA },
      ],
      account: STELLAR,
    });

    expect(prisma.customer.create.mock.calls[0][0].data.wallets.create).toEqual(
      [
        { consumerId: 'c1', chain: 'monad', address: MONAD, label: 'Rabby' },
        { consumerId: 'c1', chain: 'solana', address: SOLANA, label: null },
        { consumerId: 'c1', chain: 'stellar', address: STELLAR, label: null },
      ],
    );
    expect(created.account).toBe(MONAD);
  });

  it('collapses a wallet named twice in one request', async () => {
    const { service, prisma } = build();

    await service.create(consumer, {
      name: 'Ada',
      wallets: [{ chain: 'monad', address: MONAD }],
      account: MONAD.toLowerCase(),
    });

    expect(
      prisma.customer.create.mock.calls[0][0].data.wallets.create,
    ).toHaveLength(1);
  });

  it('refuses a wallet another customer holds, naming it and that customer (409)', async () => {
    const { service, prisma } = build();
    prisma.customerWallet.findFirst.mockResolvedValue({
      chain: 'solana',
      address: SOLANA,
      customerId: 'cus_9',
    });

    const refused = await refusal(
      service.create(consumer, {
        name: 'Ada',
        wallets: [{ chain: 'solana', address: SOLANA }],
      }),
    );

    expect(refused).toMatchObject({
      status: 409,
      code: ApiErrorCode.CustomerWalletTaken,
    });
    expect(refused.message).toContain(SOLANA);
    expect(refused.message).toContain('cus_9');
    expect(prisma.customerWallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { consumerId: 'c1', OR: [{ chain: 'solana', address: SOLANA }] },
      }),
    );
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('answers the same 409 when another request claims the wallet first (unique index)', async () => {
    const { service, prisma } = build();
    prisma.customer.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      refusal(
        service.create(consumer, {
          name: 'Ada',
          wallets: [{ chain: 'solana', address: SOLANA }],
        }),
      ),
    ).resolves.toMatchObject({
      status: 409,
      code: ApiErrorCode.CustomerWalletTaken,
    });
  });

  it('refuses more wallets than a customer may hold (400)', async () => {
    const { service, prisma } = build();
    const wallets = Array.from({ length: 20 }, (_, i) => ({
      chain: 'monad' as const,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    }));

    await expect(
      refusal(
        service.create(consumer, { name: 'Ada', wallets, account: STELLAR }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });
});

describe('CustomersService wallets', () => {
  it('adds a wallet to the customer, scoped to the consumer', async () => {
    const { service, prisma } = build([
      row('cus_1', [wallet('w1', 'stellar', STELLAR)]),
    ]);

    const added = await service.addWallet(consumer, 'cus_1', {
      chain: 'monad',
      address: MONAD.toLowerCase(),
      label: 'Rabby',
    });

    expect(prisma.customerWallet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          consumerId: 'c1',
          customerId: 'cus_1',
          chain: 'monad',
          address: MONAD,
          label: 'Rabby',
        },
      }),
    );
    expect(added).toMatchObject({ chain: 'monad', address: MONAD });
  });

  it('answers a wallet the customer already holds without writing', async () => {
    const { service, prisma } = build([
      row('cus_1', [wallet('w1', 'monad', MONAD)]),
    ]);

    const added = await service.addWallet(consumer, 'cus_1', {
      chain: 'monad',
      address: MONAD.toLowerCase(),
    });

    expect(added).toMatchObject({ id: 'w1' });
    expect(prisma.customerWallet.create).not.toHaveBeenCalled();
  });

  it('refuses a wallet another customer holds (409) and a customer of someone else (404)', async () => {
    const { service, prisma } = build([row('cus_1')]);
    prisma.customerWallet.findFirst.mockResolvedValue({
      chain: 'stellar',
      address: STELLAR,
      customerId: 'cus_2',
    });

    await expect(
      refusal(
        service.addWallet(consumer, 'cus_1', {
          chain: 'stellar',
          address: STELLAR,
        }),
      ),
    ).resolves.toMatchObject({
      status: 409,
      code: ApiErrorCode.CustomerWalletTaken,
    });
    await expect(
      refusal(
        service.addWallet(consumer, 'cus_other', {
          chain: 'stellar',
          address: STELLAR,
        }),
      ),
    ).resolves.toMatchObject({ status: 404 });
    expect(prisma.customerWallet.create).not.toHaveBeenCalled();
  });

  it('refuses a wallet past the cap', async () => {
    const full = Array.from({ length: 20 }, (_, i) =>
      wallet(`w${i}`, 'monad', `0x${String(i).padStart(40, '0')}`),
    );
    const { service } = build([row('cus_1', full)]);

    await expect(
      refusal(
        service.addWallet(consumer, 'cus_1', {
          chain: 'stellar',
          address: STELLAR,
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  });

  it('removes only a wallet of that customer', async () => {
    const { service, prisma } = build([
      row('cus_1', [wallet('w1', 'stellar', STELLAR)]),
    ]);

    await expect(
      service.removeWallet(consumer, 'cus_1', 'w1'),
    ).resolves.toEqual({ id: 'w1', deleted: true });
    expect(prisma.customerWallet.delete).toHaveBeenCalledWith({
      where: { id: 'w1' },
    });

    await expect(
      refusal(service.removeWallet(consumer, 'cus_1', 'w_of_someone')),
    ).resolves.toMatchObject({ status: 404 });
    expect(prisma.customerWallet.delete).toHaveBeenCalledTimes(1);
  });
});

/**
 * `PATCH account` edits the first wallet, as it edited the one account a customer held, so a
 * client written before wallets keeps working.
 */
describe('CustomersService.update with the deprecated account', () => {
  it('replaces the first wallet, in its chain’s spelling', async () => {
    const { service, prisma } = build([
      row('cus_1', [
        wallet('w1', 'stellar', STELLAR),
        wallet('w2', 'solana', SOLANA),
      ]),
    ]);

    await service.update(consumer, 'cus_1', { account: MONAD.toLowerCase() });

    expect(prisma.customerWallet.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { chain: 'monad', address: MONAD },
    });
    // The customer itself is written with no account field.
    expect(prisma.customer.update.mock.calls[0][0].data).toEqual({});
  });

  it('adds one when the customer has none, removes the first on null, and leaves wallets alone when omitted', async () => {
    const empty = build([row('cus_1')]);
    await empty.service.update(consumer, 'cus_1', { account: STELLAR });
    expect(empty.prisma.customerWallet.create).toHaveBeenCalledWith({
      data: {
        consumerId: 'c1',
        customerId: 'cus_1',
        chain: 'stellar',
        address: STELLAR,
        label: null,
      },
    });

    const held = build([row('cus_1', [wallet('w1', 'stellar', STELLAR)])]);
    await held.service.update(consumer, 'cus_1', { account: null });
    expect(held.prisma.customerWallet.delete).toHaveBeenCalledWith({
      where: { id: 'w1' },
    });

    await held.service.update(consumer, 'cus_1', { note: 'vip' });
    expect(held.prisma.customerWallet.update).not.toHaveBeenCalled();
    expect(held.prisma.customerWallet.create).not.toHaveBeenCalled();
    expect(held.prisma.customer.update.mock.calls[1][0].data).toEqual({
      note: 'vip',
    });
  });

  it('refuses an account another customer holds, but not the customer’s own wallet', async () => {
    const { service, prisma } = build([
      row('cus_1', [wallet('w1', 'stellar', STELLAR)]),
    ]);
    prisma.customerWallet.findFirst.mockResolvedValue({
      chain: 'solana',
      address: SOLANA,
      customerId: 'cus_2',
    });

    await expect(
      refusal(service.update(consumer, 'cus_1', { account: SOLANA })),
    ).resolves.toMatchObject({
      status: 409,
      code: ApiErrorCode.CustomerWalletTaken,
    });
    // The check leaves this customer's own wallets out.
    expect(prisma.customerWallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: { not: 'cus_1' } }),
      }),
    );
  });
});

/**
 * A settled payment's payer lands on the merchant's customer list. The rows are
 * this module's, so payment intents ask for them here rather than writing them.
 */
describe('CustomersService.ensureForPayer', () => {
  const account = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

  it("adds a first-time payer to that consumer's customers, with the wallet, marked as automatic", async () => {
    const { service, prisma } = build();

    await service.ensureForPayer('c1', 'stellar', account);

    // Scoped to the consumer and the chain: another tenant's wallet is not this merchant's.
    expect(prisma.customerWallet.findFirst).toHaveBeenCalledWith({
      where: { consumerId: 'c1', chain: 'stellar', address: account },
      select: { id: true },
    });
    expect(prisma.customer.create).toHaveBeenCalledWith({
      data: {
        consumerId: 'c1',
        name: 'GBRPYH…OX2H',
        reference: 'auto',
        wallets: {
          create: [{ consumerId: 'c1', chain: 'stellar', address: account }],
        },
      },
    });
  });

  it('leaves a payer already on the list alone, so repeat payments add no duplicate', async () => {
    const { service, prisma } = build();
    prisma.customerWallet.findFirst.mockResolvedValue({ id: 'w1' });

    await service.ensureForPayer('c1', 'stellar', account);

    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('takes a payer another settlement added a moment ago as already there', async () => {
    const { service, prisma } = build();
    prisma.customer.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.ensureForPayer('c1', 'monad', MONAD.toLowerCase()),
    ).resolves.toBeUndefined();
    expect(prisma.customerWallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { consumerId: 'c1', chain: 'monad', address: MONAD },
      }),
    );
  });
});
