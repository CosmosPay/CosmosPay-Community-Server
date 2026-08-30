import { Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { CustomersService } from './customers.service';

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['customers:read', 'customers:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};

function makeService() {
  const localConsumer = { id: 'consumer_1' };
  const prisma = {
    customer: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    paymentIntent: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };
  const consumerResolver = {
    resolve: jest.fn().mockResolvedValue(localConsumer),
  };
  const service = new CustomersService(
    prisma as never,
    consumerResolver as never,
  );
  return { service, prisma, consumerResolver, localConsumer };
}

const customer = {
  id: 'customer_1',
  consumerId: 'consumer_1',
  name: 'Alice',
  alias: null,
  email: null,
  account: 'GALICE',
  note: null,
  reference: null,
  createdAt: new Date('2026-08-30T12:00:00.000Z'),
  updatedAt: new Date('2026-08-30T12:00:00.000Z'),
};

describe('CustomersService', () => {
  it('returns paginated, exact totals separated by asset and issuer', async () => {
    const { service, prisma, localConsumer } = makeService();
    prisma.customer.findMany.mockResolvedValue([customer]);
    prisma.customer.count.mockResolvedValue(1);
    prisma.paymentIntent.findMany.mockResolvedValue([
      {
        id: 'intent_xlm',
        source: 'GALICE',
        amount: '100',
        status: 'SUCCEEDED',
        asset: 'native',
        assetIssuer: null,
      },
      {
        id: 'intent_usdc',
        source: 'GALICE',
        amount: '922337203685.4775807',
        status: 'SUCCEEDED',
        asset: 'USDC',
        assetIssuer: 'GISSUER',
      },
    ]);

    await expect(
      service.findAll(consumer, { take: 25, skip: 0 }),
    ).resolves.toEqual({
      data: [
        {
          ...customer,
          payments: 2,
          totals: [
            {
              asset: 'USDC',
              assetIssuer: 'GISSUER',
              amount: '922337203685.4775807',
              succeeded: 1,
            },
            {
              asset: 'XLM',
              assetIssuer: null,
              amount: '100.0000000',
              succeeded: 1,
            },
          ],
        },
      ],
      total: 1,
      take: 25,
      skip: 0,
    });

    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { consumerId: localConsumer.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
      skip: 0,
    });
    expect(prisma.customer.count).toHaveBeenCalledWith({
      where: { consumerId: localConsumer.id },
    });
    expect(prisma.paymentIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consumerId: localConsumer.id,
          source: { in: ['GALICE'] },
        },
        take: 1_000,
      }),
    );
  });

  it('keeps equal asset codes from different issuers separate', async () => {
    const { service, prisma } = makeService();
    prisma.customer.findMany.mockResolvedValue([customer]);
    prisma.customer.count.mockResolvedValue(1);
    prisma.paymentIntent.findMany.mockResolvedValue([
      {
        id: 'intent_a',
        source: 'GALICE',
        amount: '2.5',
        status: 'SUCCEEDED',
        asset: 'USDC',
        assetIssuer: 'GISSUER_A',
      },
      {
        id: 'intent_b',
        source: 'GALICE',
        amount: '3.25',
        status: 'SUCCEEDED',
        asset: 'USDC',
        assetIssuer: 'GISSUER_B',
      },
    ]);

    const result = await service.findAll(consumer);

    expect(result.data[0].totals).toEqual([
      {
        asset: 'USDC',
        assetIssuer: 'GISSUER_A',
        amount: '2.5000000',
        succeeded: 1,
      },
      {
        asset: 'USDC',
        assetIssuer: 'GISSUER_B',
        amount: '3.2500000',
        succeeded: 1,
      },
    ]);
  });

  it('renders a one-stroop payment without exponential notation', async () => {
    const { service, prisma } = makeService();
    prisma.customer.findMany.mockResolvedValue([customer]);
    prisma.customer.count.mockResolvedValue(1);
    prisma.paymentIntent.findMany.mockResolvedValue([
      {
        id: 'intent_micro',
        source: 'GALICE',
        amount: '0.0000001',
        status: 'SUCCEEDED',
        asset: 'native',
        assetIssuer: null,
      },
    ]);

    const result = await service.findAll(consumer);

    expect(result.data[0].totals[0].amount).toBe('0.0000001');
    expect(JSON.stringify(result)).not.toMatch(/e[+-]/i);
  });

  it('turns malformed legacy amounts into zero without rejecting the request', async () => {
    const { service, prisma } = makeService();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    prisma.customer.findMany.mockResolvedValue([customer]);
    prisma.customer.count.mockResolvedValue(1);
    prisma.paymentIntent.findMany.mockResolvedValue(
      ['abc', '', null, '1.12345678'].map((amount, index) => ({
        id: `intent_${index}`,
        source: 'GALICE',
        amount,
        status: 'SUCCEEDED',
        asset: 'native',
        assetIssuer: null,
      })),
    );

    await expect(service.findAll(consumer)).resolves.toEqual(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            payments: 4,
            totals: [
              {
                asset: 'XLM',
                assetIssuer: null,
                amount: '0.0000000',
                succeeded: 4,
              },
            ],
          }),
        ],
      }),
    );
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('does not query payment intents when the customer page has no accounts', async () => {
    const { service, prisma } = makeService();
    prisma.customer.findMany.mockResolvedValue([
      { ...customer, account: null },
    ]);
    prisma.customer.count.mockResolvedValue(1);

    const result = await service.findAll(consumer);

    expect(result.data[0]).toEqual(
      expect.objectContaining({ payments: 0, totals: [] }),
    );
    expect(prisma.paymentIntent.findMany).not.toHaveBeenCalled();
  });

  it('continues large account histories with a bounded cursor query', async () => {
    const { service, prisma } = makeService();
    prisma.customer.findMany.mockResolvedValue([customer]);
    prisma.customer.count.mockResolvedValue(1);
    prisma.paymentIntent.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: `intent_${index.toString().padStart(4, '0')}`,
          source: 'GALICE',
          amount: '1',
          status: 'SUCCEEDED',
          asset: 'native',
          assetIssuer: null,
        })),
      )
      .mockResolvedValueOnce([]);

    const result = await service.findAll(consumer);

    expect(result.data[0].totals[0].amount).toBe('1000.0000000');
    expect(prisma.paymentIntent.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.paymentIntent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: { id: 'intent_0999' },
        skip: 1,
        take: 1_000,
      }),
    );
  });

  it('uses ConsumerResolverService instead of duplicating its upsert', async () => {
    const { service, prisma, consumerResolver, localConsumer } = makeService();
    prisma.customer.create.mockResolvedValue({ id: 'customer_new' });

    await service.create(consumer, { name: 'Alice' });

    expect(consumerResolver.resolve).toHaveBeenCalledWith(consumer);
    expect(prisma.customer.create).toHaveBeenCalledWith({
      data: {
        consumerId: localConsumer.id,
        name: 'Alice',
        alias: null,
        note: null,
        email: null,
        account: null,
        reference: null,
      },
    });
  });

  it('returns 404 and never deletes across consumer boundaries', async () => {
    const { service, prisma } = makeService();
    prisma.customer.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne(consumer, 'customer_other'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.remove(consumer, 'customer_other'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'customer_other', consumerId: 'consumer_1' },
    });
    expect(prisma.customer.delete).not.toHaveBeenCalled();
  });

  describe('QueryCustomersDto', () => {
    it.each([{ take: '0' }, { take: '9999' }, { skip: '-1' }])(
      'rejects %p',
      async (input) => {
        const dto = plainToInstance(QueryCustomersDto, input);
        await expect(validate(dto)).resolves.not.toHaveLength(0);
      },
    );

    it('accepts and transforms take=25&skip=0', async () => {
      const dto = plainToInstance(QueryCustomersDto, {
        take: '25',
        skip: '0',
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto).toEqual(expect.objectContaining({ take: 25, skip: 0 }));
    });
  });
});
