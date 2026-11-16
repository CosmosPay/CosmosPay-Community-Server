import { Logger } from '@nestjs/common';
import { PaymentDepositObserverService } from '@/payment-intents/payment-deposit-observer.service';

describe('PaymentDepositObserverService', () => {
  const config = {
    get: (key: string) =>
      key === 'observer'
        ? { enabled: true, intervalMs: 15_000 }
        : { timeoutMs: 10_000 },
  } as never;
  const grantingLock = () =>
    ({
      runExclusive: jest.fn((_key: unknown, work: () => Promise<unknown>) =>
        work(),
      ),
    }) as never;

  function build(open: unknown[], unsettled: unknown[]) {
    const prisma: any = {
      paymentDeposit: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(open)
          .mockResolvedValueOnce(unsettled),
      },
    };
    const nearIntents = { status: jest.fn().mockResolvedValue(null) };
    const deposits = {
      applyProviderStatus: jest.fn().mockResolvedValue({}),
      settle: jest.fn().mockResolvedValue(undefined),
    };
    const observer = new PaymentDepositObserverService(
      config,
      prisma,
      nearIntents as never,
      deposits as never,
      grantingLock(),
    );
    return { observer, prisma, nearIntents, deposits };
  }

  it('asks the route about every open deposit, by its address and memo', async () => {
    const { observer, nearIntents, deposits } = build(
      [
        { id: 'd1', depositAddress: 'A1', depositMemo: null },
        { id: 'd2', depositAddress: 'A2', depositMemo: '42' },
      ],
      [],
    );
    await observer.tick();
    expect(nearIntents.status).toHaveBeenNthCalledWith(1, 'A1', null);
    expect(nearIntents.status).toHaveBeenNthCalledWith(2, 'A2', '42');
    expect(deposits.applyProviderStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps going past a deposit that fails, and finishes unsettled payouts', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { observer, nearIntents, deposits, prisma } = build(
      [
        { id: 'd1', depositAddress: 'A1', depositMemo: null },
        { id: 'd2', depositAddress: 'A2', depositMemo: null },
      ],
      [{ id: 'd3', intentId: 'pi_3' }],
    );
    nearIntents.status.mockRejectedValueOnce(new Error('route down'));

    await observer.tick();

    expect(deposits.applyProviderStatus).toHaveBeenCalledTimes(1);
    expect(deposits.settle).toHaveBeenCalledWith({
      id: 'd3',
      intentId: 'pi_3',
    });
    // The healing query looks only at deposits whose intent is still open.
    expect(prisma.paymentDeposit.findMany.mock.calls[1][0].where).toMatchObject(
      {
        status: 'SUCCEEDED',
        intent: { status: { in: ['PENDING', 'SUBMITTED', 'EXPIRED'] } },
      },
    );
    error.mockRestore();
  });
});
