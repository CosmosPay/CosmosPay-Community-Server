import { BlindpaySyncService } from './blindpay-sync.service';
import { WEBHOOK_EVENT } from '../webhooks/webhook-events';

function makeService() {
  const prisma = {
    payin: { findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    payout: { findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    blindpayReceiver: {
      findFirst: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const events = { emit: jest.fn() };
  const service = new BlindpaySyncService(prisma as any, events as any);
  return { service, prisma, events };
}

describe('BlindpaySyncService.handleWebhook', () => {
  it('updates a payin and re-emits PAYIN_COMPLETED to the owner', async () => {
    const { service, prisma, events } = makeService();
    prisma.payin.findFirst.mockResolvedValue({
      id: 'local1',
      status: 'processing',
      receiverId: null,
      consumer: { apisixUsername: 'cosmos_u1' },
    });
    prisma.payin.update.mockResolvedValue({});

    await service.handleWebhook('payin.complete', {
      id: 'pi_1',
      status: 'completed',
    });

    expect(prisma.payin.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'local1' },
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      WEBHOOK_EVENT,
      expect.objectContaining({
        consumerUsername: 'cosmos_u1',
        type: 'PAYIN_COMPLETED',
      }),
    );
  });

  it('maps a payout.update to PAYOUT_UPDATED', async () => {
    const { service, prisma, events } = makeService();
    prisma.payout.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'processing',
      receiverId: null,
      consumer: { apisixUsername: 'cosmos_u2' },
    });
    prisma.payout.update.mockResolvedValue({});

    await service.handleWebhook('payout.update', {
      id: 'pa_1',
      status: 'on_hold',
    });

    expect(events.emit).toHaveBeenCalledWith(
      WEBHOOK_EVENT,
      expect.objectContaining({ type: 'PAYOUT_UPDATED' }),
    );
  });

  it('ignores unmapped event types', async () => {
    const { service, prisma, events } = makeService();
    await service.handleWebhook('transfer.new', { id: 'tr_1' });
    expect(prisma.payin.findFirst).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not emit when no local record matches', async () => {
    const { service, prisma, events } = makeService();
    prisma.payin.findFirst.mockResolvedValue(null);
    await service.handleWebhook('payin.update', { id: 'pi_unknown' });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
