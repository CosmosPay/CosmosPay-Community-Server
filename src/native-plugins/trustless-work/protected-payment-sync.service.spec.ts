import { Logger } from '@nestjs/common';
import type { ProtectedPayment } from '@generated/prisma/client';
import type { AdvisoryLockService } from '@/common/services/advisory-lock.service';
import type { PrismaService } from '@/prisma/prisma.service';
import { ProtectedPaymentExpiryService } from '@/native-plugins/trustless-work/protected-payment-expiry.service';
import type { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import { ProtectedPaymentSyncService } from '@/native-plugins/trustless-work/protected-payment-sync.service';
import type { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import type {
  TrustlessWorkClient,
  TrustlessWorkContractRead,
} from '@/native-plugins/trustless-work/trustless-work.client';
import type { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

const row = (id: string, overrides: Partial<ProtectedPayment> = {}) =>
  ({
    id,
    network: 'testnet',
    status: 'AWAITING_FUNDING',
    contractId: `C_${id}`,
    deliveryWindowHours: 24,
    fundedAt: null,
    shippedAt: null,
    approvedAt: null,
    disputedAt: null,
    releasedAt: null,
    resolvedAt: null,
    fundingExpiresAt: new Date(Date.now() - 3_600_000),
    ...overrides,
  }) as ProtectedPayment;

function deps(rows: ProtectedPayment[], reads: TrustlessWorkContractRead[]) {
  const prisma = {
    protectedPayment: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: rows.length }),
    },
  } as unknown as PrismaService;
  const client = {
    timeoutMs: 1_000,
    contracts: jest.fn().mockResolvedValue(reads),
  } as unknown as TrustlessWorkClient;
  const keys = {
    isConfigured: jest.fn((n: string) => n === 'testnet'),
  } as unknown as TrustlessWorkKeys;
  const lifecycle = {
    step: jest.fn().mockResolvedValue({}),
  } as unknown as ProtectedPaymentLifecycle;
  const transactions = {
    latest: jest.fn().mockResolvedValue(null),
    outstanding: jest.fn().mockResolvedValue(false),
  } as unknown as ProtectedPaymentTransactionsService;
  const config = { get: jest.fn(() => ({ enabled: false })) };
  return { prisma, client, keys, lifecycle, transactions, config };
}

describe('ProtectedPaymentSyncService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const sync = (d: ReturnType<typeof deps>) =>
    new ProtectedPaymentSyncService(
      d.config as never,
      d.prisma,
      d.client,
      d.keys,
      d.lifecycle,
      d.transactions,
      {} as AdvisoryLockService,
    );

  it('takes every step a contract shows, with what each one records', async () => {
    const d = deps(
      [row('a')],
      [
        {
          contractId: 'C_a',
          balance: 125.5,
          milestones: [
            { status: 'shipped', evidence: 'DHL 1', approved: false },
          ],
          flags: {},
        },
      ],
    );
    await sync(d).syncNetwork('testnet');

    const calls = (d.lifecycle.step as jest.Mock).mock.calls as [
      string,
      string,
      Record<string, unknown>,
    ][];
    expect(calls.map(([, step]) => step)).toEqual(['FUNDED', 'SHIPPED']);
    expect(calls[0][2].deliveryDeadlineAt).toBeInstanceOf(Date);
    expect(calls[1][2]).toEqual({ evidence: 'DHL 1' });
    expect(d.prisma.protectedPayment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] } },
      data: { lastSyncedAt: expect.any(Date) },
    });
  });

  it('names who opened a dispute when it went through this service', async () => {
    const d = deps(
      [row('b', { status: 'FUNDED', fundedAt: new Date() })],
      [{ contractId: 'C_b', balance: 10, flags: { disputed: true } }],
    );
    (d.transactions.latest as jest.Mock).mockResolvedValue({
      status: 'SUBMITTED',
      context: { by: 'DEADLINE', reason: null },
    });
    await sync(d).syncNetwork('testnet');
    expect(d.lifecycle.step).toHaveBeenCalledWith('b', 'DISPUTED', {
      disputedBy: 'DEADLINE',
      disputeReason: null,
    });
  });

  it('reads at most 20 contracts per call', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`));
    const d = deps(rows, []);
    await sync(d).syncNetwork('testnet');
    const calls = (d.client.contracts as jest.Mock).mock.calls as [
      string,
      string[],
    ][];
    expect(calls.map(([, ids]) => ids.length)).toEqual([20, 5]);
  });

  it('stops the cycle when Trustless Work fails, leaving the batch first in line', async () => {
    const d = deps([row('c')], []);
    (d.client.contracts as jest.Mock).mockRejectedValue(new Error('429'));
    await sync(d).syncNetwork('testnet');
    expect(d.prisma.protectedPayment.updateMany).not.toHaveBeenCalled();
  });
});

describe('ProtectedPaymentExpiryService', () => {
  const expiry = (d: ReturnType<typeof deps>) =>
    new ProtectedPaymentExpiryService(
      d.config as never,
      d.prisma,
      d.client,
      d.keys,
      d.lifecycle,
      d.transactions,
      {} as AdvisoryLockService,
    );

  it('expires a payment nobody funded, without a contract', async () => {
    const d = deps([], []);
    await expect(
      expiry(d).mayExpire(
        row('a', { status: 'CREATED', contractId: null }),
        new Date(),
      ),
    ).resolves.toBe(true);
  });

  it('keeps one whose deposit can still land, or whose contract holds funds', async () => {
    const d = deps([], [{ contractId: 'C_a', balance: 5 }]);
    (d.transactions.outstanding as jest.Mock).mockResolvedValueOnce(true);
    await expect(expiry(d).mayExpire(row('a'), new Date())).resolves.toBe(
      false,
    );
    await expect(expiry(d).mayExpire(row('a'), new Date())).resolves.toBe(
      false,
    );
  });

  it('expires a deployed one whose contract is empty on-chain', async () => {
    const d = deps([], [{ contractId: 'C_a', balance: 0 }]);
    await expect(expiry(d).mayExpire(row('a'), new Date())).resolves.toBe(true);
  });
});
