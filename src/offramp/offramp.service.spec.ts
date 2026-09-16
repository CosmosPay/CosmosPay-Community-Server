import { HttpException } from '@nestjs/common';
import { BlindpayOfframpApi } from '@/blindpay/blindpay-offramp.api';
import { PAYOUT_PUBLIC_SELECT } from '@/blindpay/blindpay-sync.service';
import { OfframpService } from '@/offramp/offramp.service';

const CONSUMER = { username: 'cosmos_u1' } as any;

/** Straight out of the stored BlindPay payload — must never reach a response. */
const ACCOUNT_NUMBER = '000123456789';

/**
 * A mirrored payout row as PostgreSQL holds it, fresh (just written) unless
 * `updatedAt` is overridden. It carries every column the table has — `raw` and
 * the internal ids included — so a read that forgets its `select` hands them
 * straight back and the assertions below see it.
 */
function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payout_1',
    consumerId: 'c1',
    receiverId: null,
    blindpayId: 'pa_000000000001',
    quoteId: 'qe_000000000001',
    bankAccountId: 'ba_000000000001',
    status: 'processing',
    token: 'USDC',
    network: 'base',
    rail: 'ach',
    senderAmount: '10000',
    receiverAmount: '9900',
    senderWalletAddress: '0xabc',
    raw: {
      id: 'pa_000000000001',
      beneficiary: { account_number: ACCOUNT_NUMBER, name: 'Ada Lovelace' },
    },
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

/** What Prisma answers for a `select`: those columns only, or the whole row. */
function project(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]]),
  );
}

const PUBLIC_KEYS = Object.keys(PAYOUT_PUBLIC_SELECT).sort();

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
    environmentFor: jest.fn(() => 'prod'),
    instance: jest.fn(),
  };
  blindpay.instance.mockReturnValue(blindpay);
  const consumers = { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) };
  // The real mirror narrows its upsert to the public projection; so does this.
  const sync = {
    mirrorPayout: jest
      .fn()
      .mockResolvedValue(project(payoutRow(), PAYOUT_PUBLIC_SELECT)),
  };
  const service = new OfframpService(
    prisma,
    // The real provider surface over a mocked transport, so the paths asserted
    // below are the exact requests BlindPay receives.
    new BlindpayOfframpApi(blindpay as any),
    consumers as any,
    sync as any,
  );
  return { service, prisma, blindpay, consumers, sync };
}

/** Puts `row` in the mirror, answering reads the way Prisma would. */
function storePayout(prisma: any, row: Record<string, unknown>) {
  prisma.payout.findFirst.mockImplementation(({ select }: any) =>
    Promise.resolve(project(row, select)),
  );
}

const OWNED_QUOTE = {
  consumerId: 'c1',
  environment: 'prod',
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
      data: {
        consumerId: 'c1',
        environment: 'prod',
        blindpayId: 'qe_000000000001',
        kind: 'PAYOUT',
      },
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

  it('refuses a quote minted on the other BlindPay instance', async () => {
    const { service, prisma, blindpay } = makeService();
    // A production key executing a quote priced on the dev instance, or the
    // reverse: the id exists, but not on the instance this caller reaches.
    prisma.blindpayQuote.findUnique.mockResolvedValue({
      ...OWNED_QUOTE,
      environment: 'dev',
    });

    await expect(
      service.createPayout(CONSUMER, {
        quote_id: 'qe_000000000001',
        chain: 'evm',
        sender_wallet_address: '0xabc',
      } as any),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    expect(blindpay.post).not.toHaveBeenCalled();
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
    storePayout(prisma, payoutRow());

    const out = await service.findOne(CONSUMER, 'payout_1');

    expect(blindpay.get).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'payout_1' });
  });

  it('refreshes a stale payout from BlindPay', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    storePayout(
      prisma,
      payoutRow({ updatedAt: new Date(Date.now() - 10 * 60_000) }),
    );
    blindpay.get.mockResolvedValue({ id: 'pa_000000000001' });

    await service.findOne(CONSUMER, 'payout_1');

    expect(blindpay.get).toHaveBeenCalled();
    expect(sync.mirrorPayout).toHaveBeenCalled();
  });

  it('falls back to the mirror when the refresh fails', async () => {
    const { service, prisma, blindpay } = makeService();
    storePayout(
      prisma,
      payoutRow({ updatedAt: new Date(Date.now() - 10 * 60_000) }),
    );
    blindpay.get.mockRejectedValue(new HttpException('upstream', 502));

    await expect(service.findOne(CONSUMER, 'payout_1')).resolves.toMatchObject({
      id: 'payout_1',
      status: 'processing',
    });
  });
});

describe('OfframpService payout projection', () => {
  it('returns exactly the public fields from a fresh read — no payload, no internal ids', async () => {
    const { service, prisma } = makeService();
    storePayout(prisma, payoutRow());

    const out = await service.findOne(CONSUMER, 'payout_1');

    expect(Object.keys(out).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(out)).not.toContain(ACCOUNT_NUMBER);
    // The columns the read needs for itself are fetched, then dropped again.
    expect(prisma.payout.findFirst.mock.calls[0][0].select).not.toHaveProperty(
      'raw',
    );
  });

  it('keeps the payload out of the fallback served when a refresh fails', async () => {
    const { service, prisma, blindpay } = makeService();
    storePayout(
      prisma,
      payoutRow({ updatedAt: new Date(Date.now() - 10 * 60_000) }),
    );
    blindpay.get.mockRejectedValue(new HttpException('upstream', 502));

    const out = await service.findOne(CONSUMER, 'payout_1');

    // The fallback is the path that returned the row as read, so it is the one
    // most likely to regress.
    expect(Object.keys(out).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(out)).not.toContain(ACCOUNT_NUMBER);
  });

  it('attaches a document using only the projection', async () => {
    const { service, prisma, blindpay } = makeService();
    storePayout(prisma, payoutRow());
    blindpay.post.mockResolvedValue({ id: 'doc_1' });

    await service.addDocument(CONSUMER, 'payout_1', {} as any);

    expect(prisma.payout.findFirst.mock.calls[0][0].select).not.toHaveProperty(
      'raw',
    );
    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/payouts/pa_000000000001/documents',
      {},
    );
  });
});
