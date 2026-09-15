import { HttpException } from '@nestjs/common';
import { BlindpayOnrampApi } from '@/blindpay/blindpay-onramp.api';
import { PAYIN_PUBLIC_SELECT } from '@/blindpay/blindpay-sync.service';
import { OnrampService } from '@/onramp/onramp.service';

const CONSUMER = { username: 'cosmos_u1' } as any;

/** Straight out of the stored BlindPay payload — must never reach a response. */
const PAYER_TAX_ID = '20123456786';

/**
 * A mirrored payin row as PostgreSQL holds it, fresh (just written) unless
 * `updatedAt` is overridden. It carries every column the table has — `raw` and
 * the internal ids included — so a read that forgets its `select`, or returns
 * the row as read, hands them straight back and the assertions below see it.
 */
function payinRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payin_1',
    consumerId: 'c1',
    receiverId: null,
    blindpayId: 'pi_000000000001',
    quoteId: 'pq_000000000001',
    status: 'processing',
    token: 'USDC',
    network: 'stellar',
    paymentMethod: 'pix',
    currency: 'BRL',
    senderAmount: '10000',
    receiverAmount: '9950',
    instructions: { pix_code: '00020126' },
    raw: { id: 'pi_000000000001', pse_tax_id: PAYER_TAX_ID },
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

const PUBLIC_KEYS = Object.keys(PAYIN_PUBLIC_SELECT).sort();

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
    environmentFor: jest.fn(() => 'prod'),
    instance: jest.fn(),
  };
  blindpay.instance.mockReturnValue(blindpay);
  const consumers = { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) };
  // The real mirror narrows its upsert to the public projection; so does this.
  const sync = {
    mirrorPayin: jest
      .fn()
      .mockResolvedValue(project(payinRow(), PAYIN_PUBLIC_SELECT)),
  };
  const service = new OnrampService(
    prisma,
    // The real provider surface over a mocked transport, so the assertions below
    // are the exact requests BlindPay receives.
    new BlindpayOnrampApi(blindpay as any),
    consumers as any,
    sync as any,
  );
  return { service, prisma, blindpay, consumers, sync };
}

/** Puts `row` in the mirror, answering reads the way Prisma would. */
function storePayin(prisma: any, row: Record<string, unknown>) {
  prisma.payin.findFirst.mockImplementation(({ select }: any) =>
    Promise.resolve(project(row, select)),
  );
}

describe('OnrampService quote ownership', () => {
  it('records the minted quote against the calling consumer', async () => {
    const { service, prisma, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ id: 'pq_000000000001' });

    await service.createQuote(CONSUMER, { blockchain_wallet_id: 'w1' } as any);

    expect(prisma.blindpayQuote.create).toHaveBeenCalledWith({
      data: {
        consumerId: 'c1',
        environment: 'prod',
        blindpayId: 'pq_000000000001',
        kind: 'PAYIN',
      },
    });
  });

  it('prices the quote against the wallet the caller owns', async () => {
    const { service, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ id: 'pq_000000000001' });

    await service.createQuote(CONSUMER, { blockchain_wallet_id: 'w1' } as any);

    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/payin-quotes',
      { blockchain_wallet_id: 'bw_000000000001' },
    );
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
      environment: 'prod',
      blindpayId: 'qe_000000000001',
      kind: 'PAYOUT',
    });

    await expect(
      service.createPayin(CONSUMER, { payin_quote_id: 'qe_000000000001' }),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('refuses a quote minted on the other BlindPay instance', async () => {
    const { service, prisma, blindpay } = makeService();
    // The caller is a production key; this quote was priced on the dev instance.
    prisma.blindpayQuote.findUnique.mockResolvedValue({
      consumerId: 'c1',
      environment: 'dev',
      blindpayId: 'pq_000000000001',
      kind: 'PAYIN',
    });

    await expect(
      service.createPayin(CONSUMER, { payin_quote_id: 'pq_000000000001' }),
    ).rejects.toMatchObject({ status: 404, code: 'quote_not_found' });
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('executes a quote the caller owns', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    prisma.blindpayQuote.findUnique.mockResolvedValue({
      consumerId: 'c1',
      environment: 'prod',
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

    await expect(
      service.findAll(CONSUMER, { take: 100, skip: 0 }),
    ).resolves.toMatchObject({
      total: 57,
    });
  });

  it('serves a freshly mirrored payin without calling BlindPay', async () => {
    const { service, prisma, blindpay } = makeService();
    storePayin(prisma, payinRow());

    const out = await service.findOne(CONSUMER, 'payin_1');

    expect(blindpay.get).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'payin_1' });
  });

  it('refreshes a stale payin from BlindPay', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    storePayin(
      prisma,
      payinRow({
        receiverId: 'rcv_1',
        updatedAt: new Date(Date.now() - 10 * 60_000),
      }),
    );
    blindpay.get.mockResolvedValue({ id: 'pi_000000000001' });

    await service.findOne(CONSUMER, 'payin_1');

    expect(blindpay.get).toHaveBeenCalledWith(
      '/instances/in_test/payins/pi_000000000001',
    );
    // The refresh still needs the receiver the row was attributed to.
    expect(sync.mirrorPayin).toHaveBeenCalledWith('c1', 'prod', 'rcv_1', {
      id: 'pi_000000000001',
    });
  });

  it('falls back to the mirror when the refresh fails', async () => {
    const { service, prisma, blindpay } = makeService();
    const stale = payinRow({ updatedAt: new Date(Date.now() - 10 * 60_000) });
    storePayin(prisma, stale);
    blindpay.get.mockRejectedValue(new HttpException('upstream', 502));

    // The mirror row, as the documented entity — not the row as read.
    await expect(service.findOne(CONSUMER, 'payin_1')).resolves.toEqual(
      project(stale, PAYIN_PUBLIC_SELECT),
    );
  });
});

describe('OnrampService payin projection', () => {
  it('returns exactly the public fields from a fresh read — no internal ids', async () => {
    const { service, prisma } = makeService();
    storePayin(prisma, payinRow({ receiverId: 'rcv_1' }));

    const out = await service.findOne(CONSUMER, 'payin_1');

    // `receiverId` and `updatedAt` are fetched to drive the refresh, then dropped:
    // `PayinEntity` documents neither, and `findAll` never returned them.
    expect(Object.keys(out).sort()).toEqual(PUBLIC_KEYS);
    expect(out).not.toHaveProperty('receiverId');
    expect(out).not.toHaveProperty('updatedAt');
    expect(JSON.stringify(out)).not.toContain(PAYER_TAX_ID);
    const { select } = prisma.payin.findFirst.mock.calls[0][0];
    expect(select).toMatchObject({ receiverId: true, updatedAt: true });
    expect(select).not.toHaveProperty('raw');
  });

  it('keeps the same shape on the fallback served when a refresh fails', async () => {
    const { service, prisma, blindpay } = makeService();
    storePayin(
      prisma,
      payinRow({
        receiverId: 'rcv_1',
        updatedAt: new Date(Date.now() - 10 * 60_000),
      }),
    );
    blindpay.get.mockRejectedValue(new HttpException('upstream', 502));

    const out = await service.findOne(CONSUMER, 'payin_1');

    expect(Object.keys(out).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(out)).not.toContain(PAYER_TAX_ID);
  });
});
