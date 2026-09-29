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
      'prod',
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

  it("looks a resource up only among its own instance's rows", async () => {
    const { service, prisma } = makeService();
    prisma.payout.findFirst.mockResolvedValue(null);
    prisma.blindpayReceiver.findFirst.mockResolvedValue(null);

    await service.handleWebhook(
      'dev',
      'payout.complete',
      { id: 'pa_1', status: 'completed' },
      'msg_env_1',
    );
    await service.handleWebhook(
      'prod',
      'receiver.update',
      { id: 're_1', kyc_status: 'approved' },
      'msg_env_2',
    );

    // A delivery verified by one instance's secret cannot move the other's rows.
    expect(prisma.payout.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blindpayId: 'pa_1', environment: 'dev' },
      }),
    );
    expect(prisma.blindpayReceiver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blindpayId: 're_1', environment: 'prod' },
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
      'prod',
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
    await service.handleWebhook(
      'prod',
      'transfer.new',
      { id: 'tr_1' },
      'msg_3',
    );
    expect(prisma.payin.findFirst).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not emit when no local record matches', async () => {
    const { service, prisma, events } = makeService();
    prisma.payin.findFirst.mockResolvedValue(null);
    await service.handleWebhook(
      'prod',
      'payin.update',
      { id: 'pi_unknown' },
      'msg_4',
    );
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
      'prod',
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
      'prod',
      'receiver.update',
      { id: 're_1', kyc_status: 'rejected' },
      'msg_6',
    );
    expect(prisma.blindpayReceiver.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', kycStatus: undefined } }),
    );

    await service.handleWebhook(
      'prod',
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

describe('BlindpaySyncService create-time mirroring', () => {
  it('records the instance a mirrored resource came from', async () => {
    const { service, prisma } = makeService();

    await service.mirrorReceiver('c1', 'dev', { id: 're_1' });
    await service.mirrorPayin('c1', 'dev', null, { id: 'pi_1' });
    await service.mirrorPayout('c1', 'prod', null, { id: 'pa_1' });

    expect(prisma.blindpayReceiver.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ environment: 'dev' }),
      }),
    );
    expect(prisma.payin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ environment: 'dev' }),
      }),
    );
    expect(prisma.payout.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ environment: 'prod' }),
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
      'prod',
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
      'prod',
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
      service.handleWebhook('prod', 'payin.new', { id: 'pi_2' }, 'msg_db_down'),
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

    await service.handleWebhook('prod', 'payin.update', { id: 'pi_1' }, '');

    expect(prisma.blindpayWebhookEvent.create).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalled();
  });
});
