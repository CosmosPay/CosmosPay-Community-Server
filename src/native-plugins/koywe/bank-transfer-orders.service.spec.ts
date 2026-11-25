import { Logger } from '@nestjs/common';
import { BankTransferOrders } from '@/native-plugins/koywe/bank-transfer-orders.service';
import type { KoyweEnvelope } from '@/native-plugins/koywe/koywe-webhook';
import {
  fakeLedger,
  request,
} from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import {
  koyweDb,
  type Row,
} from '@/native-plugins/koywe/koywe-memory-db.fake-spec';

const TX = `0x${'ab'.repeat(32)}`;

function setup(requestOver: Parameters<typeof request>[0] = {}) {
  const db = koyweDb();
  const { ledger, rails, settlements, requests } = fakeLedger([
    request({ status: 'processing', ...requestOver }),
  ]);
  const client = {
    order: jest.fn(() =>
      Promise.resolve({
        id: 'ord_1',
        status: 'COMPLETED',
        amountOut: 9.97,
        transactionHash: TX,
      }),
    ),
  };
  const service = new BankTransferOrders(db as never, client as never, rails);
  const transfer: Row = {
    id: 'btr1',
    network: 'public',
    paymentRequestId: 'creq1',
    providerMerchantId: 'mrc_seller',
    providerOrderId: 'ord_1',
    providerStatus: 'PROCESSING',
    status: 'converting',
    deliveredAmount: null,
    txHash: null,
    reason: null,
  };
  db.bankTransfer.rows.push(transfer);
  return { db, service, client, ledger, settlements, requests, transfer };
}

function event(
  type: string,
  data: Row = {},
  over: Partial<KoyweEnvelope> = {},
): KoyweEnvelope {
  return {
    id: `evt_${type}`,
    type,
    environment: 'production',
    organizationId: 'org_production',
    merchantId: 'mrc_seller',
    data: {
      orderId: 'ord_1',
      type: 'ONRAMP',
      status: type.split('.')[1].toUpperCase(),
      externalId: 'btr1',
      amountIn: 15000,
      ...data,
    },
    ...over,
  };
}

describe('BankTransferOrders', () => {
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('completes the transfer and pays the request by transfer, with what the order read back says', async () => {
    const { service, client, transfer, settlements, requests } = setup();

    await service.onEvent('public', event('order.completed'));

    expect(client.order).toHaveBeenCalledWith('public', 'mrc_seller', 'ord_1');
    expect(transfer).toMatchObject({
      status: 'completed',
      providerStatus: 'COMPLETED',
      deliveredAmount: '9.97',
      txHash: TX,
      completedAt: expect.any(Date),
    });
    expect(settlements).toEqual([
      {
        id: 'creq1',
        settlement: {
          method: 'transfer',
          amount: '9.97',
          txHash: TX,
          at: expect.any(Date),
        },
      },
    ]);
    expect(requests[0].status).toBe('paid');
  });

  it('completes with the event alone when the order cannot be read back, and without a transaction', async () => {
    const { service, client, transfer, settlements } = setup();
    client.order.mockRejectedValueOnce(new Error('provider down'));

    await service.onEvent(
      'public',
      event('order.completed', { amountOut: '9.5' }),
    );

    expect(transfer).toMatchObject({
      status: 'completed',
      deliveredAmount: '9.5',
      txHash: null,
    });
    expect(settlements[0].settlement).toMatchObject({
      amount: '9.5',
      txHash: null,
    });
  });

  it('leaves a completion with no amount for the sweep', async () => {
    const { service, client, transfer, settlements } = setup();
    client.order.mockResolvedValueOnce({
      id: 'ord_1',
      status: 'COMPLETED',
    } as never);

    await service.onEvent('public', event('order.completed'));

    expect(transfer.status).toBe('converting');
    expect(settlements).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the sweep reads it back'),
    );
  });

  it('lets the first completion win: a request a P2P purchase already paid stays as it was', async () => {
    const paidAt = new Date('2026-11-12T12:00:00.000Z');
    const { service, transfer, ledger, requests } = setup({
      status: 'paid',
      paidAt,
    });

    await service.onEvent('public', event('order.completed'));

    expect(transfer.status).toBe('completed');
    expect(ledger.markPaid).toHaveBeenCalledTimes(1);
    expect(requests[0].paidAt).toBe(paidAt);
  });

  it('is idempotent, and heals a request an earlier delivery completed but did not pay', async () => {
    const { service, transfer, ledger, requests } = setup();
    await service.onEvent('public', event('order.completed'));
    await service.onEvent('public', event('order.completed'));
    expect(ledger.markPaid).toHaveBeenCalledTimes(1);

    // The transfer completed, the process died before paying the request.
    requests[0].status = 'processing';
    requests[0].paidAt = null;
    transfer.deliveredAmount = '9.97';
    await service.onEvent('public', event('order.completed'));
    expect(ledger.markPaid).toHaveBeenCalledTimes(2);
    expect(requests[0].status).toBe('paid');
  });

  it.each([
    'order.failed',
    'order.expired',
    'order.canceled',
    'order.refunded',
  ])(
    'fails the transfer on %s and leaves the request processing for ops',
    async (type) => {
      const { service, transfer, requests, settlements } = setup();

      await service.onEvent('public', event(type));

      expect(transfer).toMatchObject({
        status: 'failed',
        failedAt: expect.any(Date),
      });
      expect(requests[0].status).toBe('processing');
      expect(settlements).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('refund or convert by hand'),
      );
    },
  );

  it('only updates the status of an order still on its way, with the reason it waits for a person', async () => {
    const { service, transfer } = setup();

    await service.onEvent(
      'public',
      event('order.updated', {
        status: 'ON_HOLD',
        policyResult: 'REQUIRE_APPROVALS',
        pendingApprovalId: 'ppa_1',
      }),
    );

    expect(transfer).toMatchObject({
      status: 'converting',
      providerStatus: 'ON_HOLD',
      reason: 'approval policy REQUIRE_APPROVALS (ppa_1)',
    });
  });

  it('never moves a finished transfer back', async () => {
    const { service, transfer } = setup();
    await service.onEvent('public', event('order.completed'));

    await service.onEvent('public', event('order.failed'));
    await service.onEvent('public', event('order.processing'));

    expect(transfer.status).toBe('completed');
  });

  it('ignores another type of order, an unknown one, another network’s and another merchant’s', async () => {
    const { service, transfer } = setup();

    await service.onEvent(
      'public',
      event('order.completed', { type: 'PAYIN' }),
    );
    await service.onEvent(
      'public',
      event('order.completed', { externalId: 'btr9', orderId: 'ord_9' }),
    );
    await service.onEvent('testnet', event('order.completed'));
    await service.onEvent(
      'public',
      event('order.completed', {}, { merchantId: 'mrc_other' }),
    );

    expect(transfer.status).toBe('converting');
  });

  it('finds a transfer by the provider’s order id when the event has no external id', async () => {
    const { service, transfer } = setup();

    await service.onEvent(
      'public',
      event('order.failed', { externalId: undefined }),
    );

    expect(transfer.status).toBe('failed');
  });

  it('reads an order back for the sweep', async () => {
    const { service, transfer, settlements } = setup();

    await service.refresh(transfer as never);

    expect(transfer.status).toBe('completed');
    expect(settlements).toHaveLength(1);
  });
});
