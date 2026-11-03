import { Logger } from '@nestjs/common';
import type { ProtectedPayment } from '@generated/prisma/client';
import type { AdvisoryLockService } from '@/common/services/advisory-lock.service';
import type { PrismaService } from '@/prisma/prisma.service';
import type { ProtectedPaymentActionsService } from '@/native-plugins/trustless-work/protected-payment-actions.service';
import { ProtectedPaymentDeadlineService } from '@/native-plugins/trustless-work/protected-payment-deadline.service';
import type { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import type { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import type { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

const HOUR = 3_600_000;
const BALANCE = 1_255_000_000n;

function payment(overrides: Partial<ProtectedPayment>): ProtectedPayment {
  return {
    id: 'pp',
    network: 'testnet',
    status: 'SHIPPED',
    deadlinePolicy: 'MANUAL_REVIEW',
    deliveryDeadlineAt: new Date(Date.now() - HOUR),
    deadlinePassedAt: null,
    disputedBy: null,
    disputedAt: null,
    ...overrides,
  } as ProtectedPayment;
}

type Where = Record<string, unknown>;

/** The filters the jobs use, over an in-memory table. */
function matches(row: ProtectedPayment, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key as keyof ProtectedPayment];
    if (condition === null) return value === null;
    if (
      condition &&
      typeof condition === 'object' &&
      !(condition instanceof Date)
    ) {
      const c = condition as { in?: unknown[]; lt?: Date; not?: null };
      if (c.in) return c.in.includes(value);
      if (c.lt) return value instanceof Date && value < c.lt;
      if ('not' in c) return value !== null;
    }
    return value === condition;
  });
}

function setup(rows: ProtectedPayment[]) {
  const prisma = {
    protectedPayment: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(rows.filter((row) => matches(row, where))),
      ),
    },
  } as unknown as PrismaService;
  const lifecycle = {
    step: jest.fn((id: string) => {
      const row = rows.find((r) => r.id === id)!;
      row.deadlinePassedAt = new Date();
      return Promise.resolve(row);
    }),
  } as unknown as ProtectedPaymentLifecycle;
  const actions = {
    platformDispute: jest.fn((row: ProtectedPayment) => {
      Object.assign(row, { status: 'DISPUTED', disputedBy: 'DEADLINE' });
      return Promise.resolve({});
    }),
    balanceOf: jest.fn().mockResolvedValue(BALANCE),
    resolve: jest.fn().mockResolvedValue({ submitted: {} }),
  } as unknown as ProtectedPaymentActionsService;
  const keys = {
    isConfigured: jest.fn((network: string) => network === 'testnet'),
  } as unknown as TrustlessWorkKeys;
  const config = { get: jest.fn(() => ({ enabled: false })) };
  const job = new ProtectedPaymentDeadlineService(
    config as never,
    prisma,
    { timeoutMs: 1_000 } as TrustlessWorkClient,
    keys,
    lifecycle,
    actions,
    {} as AdvisoryLockService,
  );
  return { job, lifecycle, actions };
}

describe('ProtectedPaymentDeadlineService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** One cycle, as the timer runs it, without the advisory lock. */
  const cycle = (job: ProtectedPaymentDeadlineService) =>
    (job as unknown as { run(): Promise<void> }).run();

  it('MANUAL_REVIEW: marks the deadline once and leaves the rest to the parties and ops', async () => {
    const row = payment({ id: 'manual', deadlinePolicy: 'MANUAL_REVIEW' });
    const { job, lifecycle, actions } = setup([row]);

    await cycle(job);
    await cycle(job);

    expect(lifecycle.step).toHaveBeenCalledTimes(1);
    expect(lifecycle.step).toHaveBeenCalledWith('manual', 'DEADLINE_PASSED');
    expect(actions.platformDispute).not.toHaveBeenCalled();
    expect(actions.resolve).not.toHaveBeenCalled();
  });

  it('REFUND_BUYER: marks, disputes with the platform key, then resolves the whole balance to the buyer', async () => {
    const row = payment({ id: 'refund', deadlinePolicy: 'REFUND_BUYER' });
    const { job, lifecycle, actions } = setup([row]);

    await cycle(job);

    expect(lifecycle.step).toHaveBeenCalledWith('refund', 'DEADLINE_PASSED');
    expect(actions.platformDispute).toHaveBeenCalledWith(row, {
      by: 'DEADLINE',
      reason: null,
    });
    expect(actions.resolve).toHaveBeenCalledWith(
      row,
      { buyer: BALANCE, merchant: 0n },
      'DEADLINE',
    );
  });

  it('RELEASE_MERCHANT: resolves the whole balance to the merchant', async () => {
    const row = payment({ id: 'release', deadlinePolicy: 'RELEASE_MERCHANT' });
    const { job, actions } = setup([row]);

    await cycle(job);

    expect(actions.resolve).toHaveBeenCalledWith(
      row,
      { buyer: 0n, merchant: BALANCE },
      'DEADLINE',
    );
  });

  it('never resolves a dispute a party opened, even under an auto policy', async () => {
    const row = payment({
      id: 'party',
      status: 'DISPUTED',
      deadlinePolicy: 'REFUND_BUYER',
      deadlinePassedAt: new Date(),
      disputedBy: 'BUYER',
    });
    const { job, actions } = setup([row]);

    await cycle(job);

    expect(actions.platformDispute).not.toHaveBeenCalled();
    expect(actions.resolve).not.toHaveBeenCalled();
  });

  it('leaves a payment whose deadline has not passed, or that was released', async () => {
    const rows = [
      payment({
        id: 'early',
        deadlinePolicy: 'REFUND_BUYER',
        deliveryDeadlineAt: new Date(Date.now() + HOUR),
      }),
      payment({
        id: 'done',
        status: 'RELEASED',
        deadlinePolicy: 'REFUND_BUYER',
      }),
    ];
    const { job, lifecycle, actions } = setup(rows);

    await cycle(job);

    expect(lifecycle.step).not.toHaveBeenCalled();
    expect(actions.platformDispute).not.toHaveBeenCalled();
  });

  it('resumes after a restart: a dispute the deadline opened is resolved on the next cycle', async () => {
    const row = payment({
      id: 'resume',
      status: 'DISPUTED',
      deadlinePolicy: 'RELEASE_MERCHANT',
      deadlinePassedAt: new Date(),
      disputedBy: 'DEADLINE',
    });
    const { job, actions } = setup([row]);

    await cycle(job);

    expect(actions.platformDispute).not.toHaveBeenCalled();
    expect(actions.resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one payment fails', async () => {
    const failing = payment({ id: 'a', deadlinePolicy: 'REFUND_BUYER' });
    const fine = payment({ id: 'b', deadlinePolicy: 'REFUND_BUYER' });
    const { job, actions } = setup([failing, fine]);
    (actions.platformDispute as jest.Mock).mockRejectedValueOnce(
      new Error('Trustless Work is down'),
    );

    await cycle(job);

    expect(actions.platformDispute).toHaveBeenCalledTimes(2);
    expect(actions.resolve).toHaveBeenCalledTimes(1);
  });

  it('skips a network without Trustless Work configured', async () => {
    const row = payment({ id: 'main', network: 'public' });
    const { job, lifecycle } = setup([row]);

    await cycle(job);

    expect(lifecycle.step).not.toHaveBeenCalled();
  });
});
