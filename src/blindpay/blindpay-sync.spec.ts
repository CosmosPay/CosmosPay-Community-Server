import { BlindpaySyncService } from '@/blindpay/blindpay-sync.service';
import { WEBHOOK_EVENT } from '@/webhooks/webhook-events';

function makeService() {
  const prisma = {
    payin: { findFirst: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    payout: { findFirst: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    blindpayReceiver: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    blindpayWebhookEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const events = { emit: jest.fn() };
  const service = new BlindpaySyncService(prisma as any, events as any);
  return { service, prisma, events };
}

/** The shape Prisma throws on a unique-constraint violation. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
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
    prisma.payin.updateMany.mockResolvedValue({ count: 1 });

    await service.handleWebhook(
      'payin.complete',
      { id: 'pi_1', status: 'completed' },
      'msg_1',
    );

    expect(prisma.payin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // A settled status may always be written, so the guard adds no filter.
        where: { id: 'local1', status: undefined },
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
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });

    await service.handleWebhook(
      'payout.update',
      { id: 'pa_1', status: 'on_hold' },
      'msg_2',
    );

    expect(events.emit).toHaveBeenCalledWith(
      WEBHOOK_EVENT,
      expect.objectContaining({ type: 'PAYOUT_UPDATED' }),
    );
  });

  it('ignores unmapped event types', async () => {
    const { service, prisma, events } = makeService();
    await service.handleWebhook('transfer.new', { id: 'tr_1' }, 'msg_3');
    expect(prisma.payin.findFirst).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not emit when no local record matches', async () => {
    const { service, prisma, events } = makeService();
    prisma.payin.findFirst.mockResolvedValue(null);
    await service.handleWebhook('payin.update', { id: 'pi_unknown' }, 'msg_4');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('guards an in-flight status so it cannot overwrite a settled row', async () => {
    const { service, prisma } = makeService();
    prisma.payin.findFirst.mockResolvedValue({
      id: 'local1',
      status: 'completed',
      receiverId: null,
      consumer: { apisixUsername: 'cosmos_u1' },
    });
    prisma.payin.updateMany.mockResolvedValue({ count: 0 });

    await service.handleWebhook(
      'payin.update',
      { id: 'pi_1', status: 'processing' },
      'msg_5',
    );

    expect(prisma.payin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'local1',
          status: {
            notIn: ['completed', 'failed', 'refunded', 'cancelled'],
          },
        },
      }),
    );
  });

  it('lets a settled receiver status land but not an in-flight one', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findFirst.mockResolvedValue({
      id: 'r1',
      kycStatus: 'verifying',
      consumer: { apisixUsername: 'cosmos_u3' },
    });
    prisma.blindpayReceiver.updateMany.mockResolvedValue({ count: 1 });

    await service.handleWebhook(
      'receiver.update',
      { id: 're_1', kyc_status: 'rejected' },
      'msg_6',
    );
    expect(prisma.blindpayReceiver.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', kycStatus: undefined } }),
    );

    await service.handleWebhook(
      'receiver.update',
      { id: 're_1', kyc_status: 'verifying' },
      'msg_7',
    );
    expect(prisma.blindpayReceiver.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'r1', kycStatus: { notIn: ['approved', 'rejected'] } },
      }),
    );
  });
});

describe('BlindpaySyncService delivery de-duplication', () => {
  it('claims the delivery by svix-id before applying it', async () => {
    const { service, prisma } = makeService();
    prisma.payin.findFirst.mockResolvedValue({
      id: 'local1',
      status: 'processing',
      receiverId: null,
      consumer: { apisixUsername: 'cosmos_u1' },
    });
    prisma.payin.updateMany.mockResolvedValue({ count: 1 });

    await service.handleWebhook(
      'payin.complete',
      { id: 'pi_1', status: 'completed' },
      'msg_claim',
    );

    expect(prisma.blindpayWebhookEvent.create).toHaveBeenCalledWith({
      data: { svixId: 'msg_claim', eventType: 'payin.complete' },
    });
  });

  it('drops a retry of an already-claimed delivery without emitting', async () => {
    const { service, prisma, events } = makeService();
    prisma.blindpayWebhookEvent.create.mockRejectedValue(uniqueViolation());

    await service.handleWebhook(
      'payout.complete',
      { id: 'pa_1', status: 'completed' },
      'msg_retry',
    );

    expect(prisma.payout.findFirst).not.toHaveBeenCalled();
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rethrows a claim failure that is not a duplicate, so Svix retries', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayWebhookEvent.create.mockRejectedValue(
      new Error('connection reset'),
    );

    await expect(
      service.handleWebhook('payin.new', { id: 'pi_2' }, 'msg_db_down'),
    ).rejects.toThrow('connection reset');
  });

  it('still processes a delivery that carries no svix-id', async () => {
    const { service, prisma, events } = makeService();
    prisma.payin.findFirst.mockResolvedValue({
      id: 'local1',
      status: 'processing',
      receiverId: null,
      consumer: { apisixUsername: 'cosmos_u1' },
    });
    prisma.payin.updateMany.mockResolvedValue({ count: 1 });

    await service.handleWebhook('payin.update', { id: 'pi_1' }, '');

    expect(prisma.blindpayWebhookEvent.create).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalled();
  });
});
