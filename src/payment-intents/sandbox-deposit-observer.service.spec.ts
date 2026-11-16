import { Logger } from '@nestjs/common';
import { SandboxDepositObserverService } from '@/payment-intents/sandbox-deposit-observer.service';

describe('SandboxDepositObserverService', () => {
  const locks = {
    runExclusive: jest.fn((_key: unknown, work: () => Promise<unknown>) =>
      work(),
    ),
  } as never;

  function build(rows: unknown[], configured = true) {
    const config = {
      get: (key: string) =>
        key === 'observer'
          ? { enabled: true, intervalMs: 15_000 }
          : { timeoutMs: 1000 },
    } as never;
    const prisma: any = {
      paymentDeposit: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const route = { isConfigured: () => configured };
    const settler = {
      observe: jest.fn((d: { id: string }) =>
        Promise.resolve({
          correlationId: d.id,
          status: 'PROCESSING',
          updatedAt: '',
        }),
      ),
    };
    const deposits = { applyProviderStatus: jest.fn().mockResolvedValue({}) };
    const observer = new SandboxDepositObserverService(
      config,
      prisma,
      route as never,
      settler as never,
      deposits as never,
      locks,
    );
    return { observer, prisma, settler, deposits };
  }

  it('follows only test-network deposits, handing each answer to the payment links', async () => {
    const { observer, prisma, settler, deposits } = build([
      { id: 'd1' },
      { id: 'd2' },
    ]);
    await observer.tick();
    expect(prisma.paymentDeposit.findMany.mock.calls[0][0].where).toMatchObject(
      {
        network: 'testnet',
      },
    );
    expect(settler.observe).toHaveBeenCalledTimes(2);
    expect(deposits.applyProviderStatus).toHaveBeenCalledWith(
      { id: 'd1' },
      expect.objectContaining({ status: 'PROCESSING' }),
    );
  });

  it('keeps going past a deposit that fails', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { observer, settler, deposits } = build([{ id: 'd1' }, { id: 'd2' }]);
    settler.observe.mockRejectedValueOnce(new Error('test network down'));
    await observer.tick();
    expect(deposits.applyProviderStatus).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('stays off until the sandbox is configured', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const interval = jest.spyOn(global, 'setInterval');
    const { observer } = build([{ id: 'd1' }], false);
    observer.onModuleInit();
    expect(interval).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/SANDBOX_DEPOSIT_SEED.*disabled$/),
    );
    observer.onModuleDestroy();
    interval.mockRestore();
    log.mockRestore();
  });
});
