import { HttpException } from '@nestjs/common';
import { OnrampService } from './onramp.service';

const CONSUMER = { username: 'cosmos_u1' } as any;

/** A mirrored payin row, fresh (just written) unless `updatedAt` is overridden. */
function payinRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payin_1',
    consumerId: 'c1',
    receiverId: null,
    blindpayId: 'pi_000000000001',
    status: 'processing',
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    payin: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    blindpayQuote: { create: jest.fn(), findUnique: jest.fn() },
    blindpayBlockchainWallet: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'w1',
        receiverId: 'rcv_1',
        blindpayId: 'bw_000000000001',
      }),
    },
    blindpayReceiver: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ disabled: false }),
    },
  };
  const blindpay = {
    post: jest.fn(),
    get: jest.fn(),
    instanceId: 'in_test',
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
  };
  const consumers = { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const sync = { mirrorPayin: jest.fn().mockResolvedValue(payinRow()) };
  const service = new OnrampService(
    prisma,
    blindpay as any,
    consumers as any,
    sync as any,
  );
  return { service, prisma, blindpay, consumers, sync };
}

describe('OnrampService quote ownership', () => {
  it('records the minted quote against the calling consumer', async () => {
    const { service, prisma, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ id: 'pq_000000000001' });

    await service.createQuote(CONSUMER, { blockchain_wallet_id: 'w1' } as any);

    expect(prisma.blindpayQuote.create).toHaveBeenCalledWith({
      data: { consumerId: 'c1', blindpayId: 'pq_000000000001', kind: 'PAYIN' },
    });
  });

  it('fails the quote when BlindPay returns no id to own', async () => {
    const { service, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ status: 'ok' });

    await expect(
      service.createQuote(CONSUMER, { blockchain_wallet_id: 'w1' } as any),
    ).rejects.toMatchObject({ status: 502, code: 'provider_error' });
  });

  it('refuses to execute a quote minted by another consumer', async () => {
    const { service, prisma, blindpay } = makeService();
    // Scoped by (consumerId, blindpayId): another tenant's quote simply misses.
    prisma.blindpayQuote.findUnique.mockResolvedValue(null);

    await expect(
      service.createPayin(CONSUMER, { payin_quote_id: 'pq_stolen' }),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    // The guard runs before anything reaches the provider.
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('refuses a payout quote id on the payin route', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayQuote.findUnique.mockResolvedValue({
      consumerId: 'c1',
      blindpayId: 'qe_000000000001',
      kind: 'PAYOUT',
    });

    await expect(
      service.createPayin(CONSUMER, { payin_quote_id: 'qe_000000000001' }),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('executes a quote the caller owns', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    prisma.blindpayQuote.findUnique.mockResolvedValue({
      consumerId: 'c1',
      blindpayId: 'pq_000000000001',
      kind: 'PAYIN',
    });
    blindpay.post.mockResolvedValue({ id: 'pi_1', receiver_id: null });

    await service.createPayin(CONSUMER, { payin_quote_id: 'pq_000000000001' });

    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/payins/evm',
      { payin_quote_id: 'pq_000000000001' },
    );
    expect(sync.mirrorPayin).toHaveBeenCalled();
  });
});

describe('OnrampService reads', () => {
  it('reports the row count, not the page length', async () => {
    const { service, prisma } = makeService();
    prisma.payin.findMany.mockResolvedValue([payinRow(), payinRow()]);
    prisma.payin.count.mockResolvedValue(57);

    await expect(service.findAll(CONSUMER)).resolves.toMatchObject({
      total: 57,
    });
  });

  it('serves a freshly mirrored payin without calling BlindPay', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.payin.findFirst.mockResolvedValue(payinRow());

    const out = await service.findOne(CONSUMER, 'payin_1');

    expect(blindpay.get).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'payin_1' });
  });

  it('refreshes a stale payin from BlindPay', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    prisma.payin.findFirst.mockResolvedValue(
      payinRow({ updatedAt: new Date(Date.now() - 10 * 60_000) }),
    );
    blindpay.get.mockResolvedValue({ id: 'pi_000000000001' });

    await service.findOne(CONSUMER, 'payin_1');

    expect(blindpay.get).toHaveBeenCalled();
    expect(sync.mirrorPayin).toHaveBeenCalled();
  });

  it('falls back to the mirror when the refresh fails', async () => {
    const { service, prisma, blindpay } = makeService();
    const stale = payinRow({ updatedAt: new Date(Date.now() - 10 * 60_000) });
    prisma.payin.findFirst.mockResolvedValue(stale);
    blindpay.get.mockRejectedValue(new HttpException('upstream', 502));

    await expect(service.findOne(CONSUMER, 'payin_1')).resolves.toBe(stale);
  });
});
