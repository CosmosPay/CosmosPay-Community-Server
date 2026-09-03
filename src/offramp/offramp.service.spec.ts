import { HttpException } from '@nestjs/common';
import { OfframpService } from '@/offramp/offramp.service';

const CONSUMER = { username: 'cosmos_u1' } as any;

/** A mirrored payout row, fresh (just written) unless `updatedAt` is overridden. */
function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payout_1',
    consumerId: 'c1',
    receiverId: null,
    blindpayId: 'pa_000000000001',
    status: 'processing',
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    payout: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    blindpayQuote: { create: jest.fn(), findUnique: jest.fn() },
    blindpayBankAccount: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ba1',
        receiverId: 'rcv_1',
        blindpayId: 'ba_000000000001',
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
  const sync = { mirrorPayout: jest.fn().mockResolvedValue(payoutRow()) };
  const service = new OfframpService(
    prisma,
    blindpay as any,
    consumers as any,
    sync as any,
  );
  return { service, prisma, blindpay, consumers, sync };
}

const OWNED_QUOTE = {
  consumerId: 'c1',
  blindpayId: 'qe_000000000001',
  kind: 'PAYOUT',
};

describe('OfframpService quote ownership', () => {
  it('records the minted quote against the calling consumer', async () => {
    const { service, prisma, blindpay } = makeService();
    blindpay.post.mockResolvedValue({
      id: 'qe_000000000001',
      receiver_amount: 1000,
    });

    await service.createQuote(CONSUMER, { bank_account_id: 'ba1' } as any);

    expect(prisma.blindpayQuote.create).toHaveBeenCalledWith({
      data: { consumerId: 'c1', blindpayId: 'qe_000000000001', kind: 'PAYOUT' },
    });
  });

  it('fails the quote when BlindPay returns no id to own', async () => {
    const { service, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ receiver_amount: 1000 });

    await expect(
      service.createQuote(CONSUMER, { bank_account_id: 'ba1' } as any),
    ).rejects.toMatchObject({ status: 502, code: 'provider_error' });
  });

  it('refuses to authorize a quote minted by another consumer', async () => {
    const { service, prisma, blindpay } = makeService();
    // Scoped by (consumerId, blindpayId): another tenant's quote simply misses.
    prisma.blindpayQuote.findUnique.mockResolvedValue(null);

    await expect(
      service.authorize(CONSUMER, {
        quote_id: 'qe_stolen',
        chain: 'stellar',
        sender_wallet_address: 'GABC',
      } as any),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('refuses to execute a quote minted by another consumer', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayQuote.findUnique.mockResolvedValue(null);

    await expect(
      service.createPayout(CONSUMER, {
        quote_id: 'qe_stolen',
        chain: 'evm',
        sender_wallet_address: '0xabc',
      } as any),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    // The guard runs before anything reaches the provider.
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('refuses a payin quote id on the payout route', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayQuote.findUnique.mockResolvedValue({
      ...OWNED_QUOTE,
      kind: 'PAYIN',
    });

    await expect(
      service.createPayout(CONSUMER, {
        quote_id: 'qe_000000000001',
        chain: 'evm',
        sender_wallet_address: '0xabc',
      } as any),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
  });

  it('executes a quote the caller owns', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    prisma.blindpayQuote.findUnique.mockResolvedValue(OWNED_QUOTE);
    blindpay.post.mockResolvedValue({ id: 'pa_1', receiver_id: null });

    await service.createPayout(CONSUMER, {
      quote_id: 'qe_000000000001',
      chain: 'evm',
      sender_wallet_address: '0xabc',
    } as any);

    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/payouts/evm',
      expect.objectContaining({ quote_id: 'qe_000000000001' }),
    );
    expect(sync.mirrorPayout).toHaveBeenCalled();
  });
});

describe('OfframpService reads', () => {
  it('reports the row count, not the page length', async () => {
    const { service, prisma } = makeService();
    prisma.payout.findMany.mockResolvedValue([payoutRow(), payoutRow()]);
    prisma.payout.count.mockResolvedValue(41);

    await expect(
      service.findAll(CONSUMER, { take: 100, skip: 0 }),
    ).resolves.toMatchObject({
      total: 41,
    });
  });

  it('serves a freshly mirrored payout without calling BlindPay', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.payout.findFirst.mockResolvedValue(payoutRow());

    const out = await service.findOne(CONSUMER, 'payout_1');

    expect(blindpay.get).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'payout_1' });
  });

  it('refreshes a stale payout from BlindPay', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    prisma.payout.findFirst.mockResolvedValue(
      payoutRow({ updatedAt: new Date(Date.now() - 10 * 60_000) }),
    );
    blindpay.get.mockResolvedValue({ id: 'pa_000000000001' });

    await service.findOne(CONSUMER, 'payout_1');

    expect(blindpay.get).toHaveBeenCalled();
    expect(sync.mirrorPayout).toHaveBeenCalled();
  });

  it('falls back to the mirror when the refresh fails', async () => {
    const { service, prisma, blindpay } = makeService();
    const stale = payoutRow({ updatedAt: new Date(Date.now() - 10 * 60_000) });
    prisma.payout.findFirst.mockResolvedValue(stale);
    blindpay.get.mockRejectedValue(new HttpException('upstream', 502));

    await expect(service.findOne(CONSUMER, 'payout_1')).resolves.toBe(stale);
  });
});
