import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import type { P2pOrderRow } from '@/p2p/p2p-views';

const ORDER_ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const OTHER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const CONSUMER = { username: 'cosmos_u1', environment: 'dev' } as never;

const row = (overrides: Partial<P2pOrderRow> = {}): P2pOrderRow =>
  ({
    id: ORDER_ID,
    consumerId: 'consumer_client',
    merchantConsumerId: 'consumer_merchant',
    tier: 'testnet',
    kind: 'BUY',
    network: 'base',
    status: 'awaiting_payment',
    onchainId: '7',
    merchantPaymentMethodId: 'pm_1',
    buyerAddress: RECIPIENT,
    sellerAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    ...overrides,
  }) as P2pOrderRow;

function setup(orderRow: P2pOrderRow | null = row()) {
  const prisma = {
    p2pQuote: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'q1',
        side: 'BUY',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    },
    p2pOrder: {
      findFirst: jest.fn().mockResolvedValue(orderRow),
      findUnique: jest.fn(({ select }: { select: Record<string, boolean> }) =>
        Promise.resolve(
          select.payerInfo
            ? { payerInfo: 'sealed-payer', beneficiary: null }
            : orderRow,
        ),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const matcher = { send: jest.fn().mockResolvedValue('0xhash') };
  const paymentMethods = {
    paymentDetailsOf: jest.fn().mockResolvedValue({
      rail: 'ar_bank_transfer',
      holderName: 'María',
      details: { alias: 'pampa' },
    }),
  };
  const cipher = {
    open: jest.fn().mockReturnValue({
      name: 'Juan',
      document: '20123456786',
      email: 'juan@example.com',
    }),
  };
  const service = new P2pOrdersService(
    prisma as never,
    { resolveId: jest.fn().mockResolvedValue('consumer_client') } as never,
    { tierFor: () => 'testnet' } as never,
    { requireLive: jest.fn().mockResolvedValue({ network: 'base' }) } as never,
    {} as never,
    {} as never,
    matcher as never,
    paymentMethods as never,
    cipher as never,
  );
  return { service, prisma, matcher, paymentMethods };
}

describe('P2pOrdersService', () => {
  it('shows the client where to pay only on a live purchase or charge', async () => {
    const { service } = setup();
    expect((await service.clientView(row(), true)).paymentDetails).toEqual({
      rail: 'ar_bank_transfer',
      holderName: 'María',
      details: { alias: 'pampa' },
    });
    expect(
      (await service.clientView(row({ status: 'completed' }), true))
        .paymentDetails,
    ).toBeNull();
    expect(
      (await service.clientView(row({ kind: 'PAYOUT' }), true)).paymentDetails,
    ).toBeNull();
    expect((await service.clientView(row(), false)).paymentDetails).toBeNull();
  });

  it('shows the merchant the payer’s name and document, never the email, and only while live', async () => {
    const { service } = setup();
    const live = await service.merchantView(row());
    expect(live.payer).toEqual({ name: 'Juan', document: '20123456786' });
    const ended = await service.merchantView(row({ status: 'cancelled' }));
    expect(ended.payer).toBeNull();
  });

  it('answers a replay with the same wallet, and 409 with another', async () => {
    const { service } = setup(row({ status: 'pending' }));
    const replay = await service.create(CONSUMER, {
      quoteId: 'q1',
      recipient: RECIPIENT,
      payer: { name: 'Juan', document: '20123456786' },
    });
    expect(replay.id).toBe(ORDER_ID);
    await expect(
      service.create(CONSUMER, {
        quoteId: 'q1',
        recipient: OTHER,
        payer: { name: 'Juan', document: '20123456786' },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('sends the matcher’s markPaid for a purchase awaiting payment, with the reference kept', async () => {
    const { service, matcher, prisma } = setup();
    await service.act(CONSUMER, ORDER_ID, 'paid', { reference: 'TRX-1' });
    expect(matcher.send).toHaveBeenCalledWith(
      { network: 'base' },
      expect.objectContaining({ kind: 'markPaid', orderId: ORDER_ID }),
    );
    expect(prisma.p2pOrder.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      data: { paidReference: 'TRX-1' },
    });
  });

  it('refuses matcher acts the matcher may not take for the client', async () => {
    const cases: [Partial<P2pOrderRow>, 'paid' | 'cancel' | 'dispute'][] = [
      [{ kind: 'SELL' }, 'cancel'],
      [{ kind: 'PAYOUT', status: 'awaiting_payment' }, 'cancel'],
      [{ kind: 'PAYOUT', status: 'paid' }, 'dispute'],
      [{ status: 'paid' }, 'paid'],
      [{ status: 'awaiting_payment' }, 'dispute'],
      [{ onchainId: null }, 'paid'],
    ];
    for (const [overrides, action] of cases) {
      const { service, matcher } = setup(row(overrides));
      await expect(
        service.act(CONSUMER, ORDER_ID, action),
      ).rejects.toMatchObject({
        code: 'invalid_state_transition',
      });
      expect(matcher.send).not.toHaveBeenCalled();
    }
  });

  it('lets the client withdraw a payout nobody accepted yet', async () => {
    const { service, matcher } = setup(
      row({ kind: 'PAYOUT', status: 'awaiting_acceptance' }),
    );
    await service.act(CONSUMER, ORDER_ID, 'cancel');
    expect(matcher.send).toHaveBeenCalledWith(
      { network: 'base' },
      expect.objectContaining({ kind: 'cancel' }),
    );
  });

  it('answers 404 for an id that is not a uuid without reading the table', async () => {
    const { service, prisma } = setup();
    await expect(service.get(CONSUMER, 'not-a-uuid')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(prisma.p2pOrder.findFirst).not.toHaveBeenCalled();
  });
});
