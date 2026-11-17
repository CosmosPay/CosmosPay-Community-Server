import { Logger } from '@nestjs/common';
import { PaymentReceiptSweeperService } from '@/payment-intents/payment-receipt-sweeper.service';

describe('PaymentReceiptSweeperService', () => {
  const config = {
    get: () => ({ enabled: true, intervalMs: 15_000 }),
  } as never;
  const locks = {
    runExclusive: jest.fn((_key: unknown, work: () => Promise<unknown>) =>
      work(),
    ),
  } as never;

  it('retries the settled payments whose receipt has not gone out, one failure not stopping the rest', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const prisma: any = {
      paymentIntent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'pi_1' }, { id: 'pi_2' }]),
      },
    };
    const receipts = {
      send: jest
        .fn()
        .mockRejectedValueOnce(new Error('mail down'))
        .mockResolvedValueOnce(true),
    };
    const sweeper = new PaymentReceiptSweeperService(
      config,
      prisma,
      receipts as never,
      locks,
    );

    await sweeper.tick();

    const where = prisma.paymentIntent.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'SUCCEEDED', receiptSentAt: null });
    expect(receipts.send).toHaveBeenNthCalledWith(1, 'pi_1');
    expect(receipts.send).toHaveBeenNthCalledWith(2, 'pi_2');
    warn.mockRestore();
  });
});
