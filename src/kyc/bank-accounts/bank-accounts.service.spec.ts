import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BlindpayClient } from '../../blindpay/blindpay.client';
import { ConsumerResolverService } from '../../blindpay/consumer-resolver.service';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { ReceiversService } from '../receivers/receivers.service';
import { BankAccountsService } from './bank-accounts.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['kyc:read', 'kyc:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};

const dto: CreateBankAccountDto = {
  type: 'ach',
  name: 'Primary ACH',
};

function makeService() {
  const prisma = {
    blindpayBankAccount: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const blindpay = {
    post: jest.fn(),
    delete: jest.fn(),
    instancePath: jest.fn((path: string) => `/instances/in_test${path}`),
  };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'consumer_1' }),
  };
  const receivers = {
    findReceiverOrThrow: jest.fn(),
    assertEnabled: jest.fn(),
  };
  const service = new BankAccountsService(
    prisma as unknown as PrismaService,
    blindpay as unknown as BlindpayClient,
    consumers as unknown as ConsumerResolverService,
    receivers as unknown as ReceiversService,
  );
  return { service, prisma, blindpay, receivers };
}

describe('BankAccountsService', () => {
  it('scopes every public operation through findReceiverOrThrow', async () => {
    const { service, prisma, blindpay, receivers } = makeService();
    receivers.findReceiverOrThrow.mockRejectedValue(
      new NotFoundException('Receiver not found'),
    );

    const operations = [
      () => service.create(consumer, 'receiver_other', dto),
      () => service.findAll(consumer, 'receiver_other'),
      () => service.remove(consumer, 'receiver_other', 'bank_1'),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(receivers.findReceiverOrThrow).toHaveBeenCalledTimes(3);
    expect(prisma.blindpayBankAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.blindpayBankAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.blindpayBankAccount.upsert).not.toHaveBeenCalled();
    expect(blindpay.post).not.toHaveBeenCalled();
    expect(blindpay.delete).not.toHaveBeenCalled();
  });

  it('checks assertEnabled before creating anything upstream', async () => {
    const { service, prisma, blindpay, receivers } = makeService();
    receivers.findReceiverOrThrow.mockResolvedValue({
      id: 'receiver_1',
      blindpayId: 're_1',
      disabled: true,
    });
    receivers.assertEnabled.mockImplementation(() => {
      throw new ForbiddenException('disabled');
    });

    await expect(
      service.create(consumer, 'receiver_1', dto),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(blindpay.post).not.toHaveBeenCalled();
    expect(prisma.blindpayBankAccount.upsert).not.toHaveBeenCalled();
  });

  it('asserts access before POST and mirrors a created bank account', async () => {
    const { service, prisma, blindpay, receivers } = makeService();
    receivers.findReceiverOrThrow.mockResolvedValue({
      id: 'receiver_1',
      blindpayId: 're_1',
      disabled: false,
    });
    blindpay.post.mockResolvedValue({
      id: 'ba_1',
      type: 'ach',
      name: 'Primary ACH',
      country: 'US',
    });
    prisma.blindpayBankAccount.upsert.mockResolvedValue({ id: 'bank_1' });

    await expect(service.create(consumer, 'receiver_1', dto)).resolves.toEqual({
      id: 'bank_1',
    });

    expect(receivers.assertEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      blindpay.post.mock.invocationCallOrder[0],
    );
    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/bank-accounts',
      dto,
    );
    expect(prisma.blindpayBankAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consumerId_blindpayId: {
            consumerId: 'consumer_1',
            blindpayId: 'ba_1',
          },
        },
      }),
    );
  });

  it('lists only bank accounts attached to the scoped receiver', async () => {
    const { service, prisma, receivers } = makeService();
    receivers.findReceiverOrThrow.mockResolvedValue({ id: 'receiver_1' });
    prisma.blindpayBankAccount.findMany.mockResolvedValue([{ id: 'bank_1' }]);

    await expect(service.findAll(consumer, 'receiver_1')).resolves.toEqual({
      data: [{ id: 'bank_1' }],
      total: 1,
    });
    expect(prisma.blindpayBankAccount.findMany).toHaveBeenCalledWith({
      where: { receiverId: 'receiver_1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('documents the existing false-positive remove for a missing row', async () => {
    const { service, prisma, blindpay, receivers } = makeService();
    receivers.findReceiverOrThrow.mockResolvedValue({
      id: 'receiver_1',
      blindpayId: 're_1',
    });
    prisma.blindpayBankAccount.findFirst.mockResolvedValue(null);

    // Issue #15 intentionally documents this behavior; fixing it is out of scope.
    await expect(
      service.remove(consumer, 'receiver_1', 'bank_missing'),
    ).resolves.toEqual({ id: 'bank_missing', deleted: true });
    expect(blindpay.delete).not.toHaveBeenCalled();
    expect(prisma.blindpayBankAccount.delete).not.toHaveBeenCalled();
  });
});
