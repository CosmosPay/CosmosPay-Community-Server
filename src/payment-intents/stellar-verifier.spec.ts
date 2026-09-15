import { Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from '@/stellar/stellar.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import {
  PAYMENT_SCAN_MAX_PAGES,
  PAYMENT_SCAN_PAGE_SIZE,
  TX_CREATED_AT_SKEW_MS,
} from '@/payment-intents/payment-intents.constants';

const CREATED_AT = new Date('2026-09-01T12:00:00.000Z');
/** A ledger close time `offsetMs` after (or, negative, before) the intent. */
const closedAt = (offsetMs: number) =>
  new Date(CREATED_AT.getTime() + offsetMs).toISOString();

const config = {
  get: () => ({
    horizon: {
      public: 'https://horizon.test',
      testnet: 'https://horizon.test',
    },
  }),
} as any;
const stellar = new StellarService(config);
const make = () => new StellarVerifierService(stellar);

const nativeTo = (to: string, amount: string) => ({
  type: 'payment',
  asset_type: 'native',
  to,
  amount,
});

describe('StellarVerifierService.verifyByHash', () => {
  const intent: any = {
    id: 'pi_1',
    network: 'testnet',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123456789',
    createdAt: CREATED_AT,
  };

  /** The transaction closes 30 s after the intent unless `created_at` says otherwise. */
  function mockHorizon(
    tx: {
      successful: boolean;
      memo_type?: string;
      memo?: string;
      created_at?: string;
    },
    paymentRecords: any[],
  ) {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => ({ created_at: closedAt(30_000), ...tx }),
      }),
    } as any);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: () => ({
        call: async () => ({ records: paymentRecords }),
      }),
    } as any);
  }

  afterEach(() => jest.restoreAllMocks());

  it('accepts a successful tx with matching destination, amount and memo', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GDEST', '25.5000000'),
    ]);
    const res = await make().verifyByHash(intent, 'a'.repeat(64));
    expect(res.valid).toBe(true);
  });

  it('rejects a memo mismatch', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '999' }, [
      nativeTo('GDEST', '25.5'),
    ]);
    const res = await make().verifyByHash(intent, 'b'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/Memo mismatch/);
  });

  it('rejects when no payment matches destination/amount', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GOTHER', '25.5'),
      nativeTo('GDEST', '10'),
    ]);
    const res = await make().verifyByHash(intent, 'c'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/No native payment/);
  });

  /**
   * FAILED is terminal, and `POST /:id/validate` settles to it on this result.
   * Checking success before anything else let the hash of any failed
   * transaction on the network permanently fail an unrelated intent.
   */
  describe('a failed transaction', () => {
    it("is reported as failed on-chain when it is this intent's payment", async () => {
      mockHorizon({ successful: false, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GDEST', '25.5'),
      ]);
      const res = await make().verifyByHash(intent, 'd'.repeat(64));
      expect(res).toEqual({
        valid: false,
        failedOnChain: true,
        reason: 'Transaction failed on-chain',
      });
    });

    it('is only a mismatch when its memo belongs to something else', async () => {
      mockHorizon({ successful: false, memo_type: 'id', memo: '999' }, [
        nativeTo('GDEST', '25.5'),
      ]);
      const res = await make().verifyByHash(intent, 'd'.repeat(64));
      expect(res.valid).toBe(false);
      expect(res.failedOnChain).toBeUndefined();
      expect(res.reason).toMatch(/Memo mismatch/);
    });

    it('is only a mismatch when it carries no memo at all', async () => {
      mockHorizon({ successful: false, memo_type: 'none' }, []);
      const res = await make().verifyByHash(intent, 'd'.repeat(64));
      expect(res.failedOnChain).toBeUndefined();
    });

    it("is only a mismatch when it pays nothing to the intent's destination", async () => {
      mockHorizon({ successful: false, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GOTHER', '25.5'),
      ]);
      const res = await make().verifyByHash(intent, 'd'.repeat(64));
      expect(res.valid).toBe(false);
      expect(res.failedOnChain).toBeUndefined();
      expect(res.reason).toMatch(/No native payment/);
    });

    it('is only a mismatch when it pays the destination in another asset', async () => {
      mockHorizon({ successful: false, memo_type: 'id', memo: '123456789' }, [
        {
          type: 'payment',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GISSUER',
          to: 'GDEST',
          amount: '25.5',
        },
      ]);
      const res = await make().verifyByHash(intent, 'd'.repeat(64));
      expect(res.failedOnChain).toBeUndefined();
    });
  });

  describe('transaction age', () => {
    it('rejects a matching payment that closed before the intent existed', async () => {
      // Same memo, destination and amount — an older intent's payment under a
      // reused memo, which used to settle the new one.
      mockHorizon(
        {
          successful: true,
          memo_type: 'id',
          memo: '123456789',
          created_at: closedAt(-TX_CREATED_AT_SKEW_MS - 1_000),
        },
        [nativeTo('GDEST', '25.5')],
      );
      const res = await make().verifyByHash(intent, 'e'.repeat(64));
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/predates/);
    });

    it('does not let an old failed payment fail a new intent either', async () => {
      mockHorizon(
        {
          successful: false,
          memo_type: 'id',
          memo: '123456789',
          created_at: closedAt(-10 * 60_000),
        },
        [nativeTo('GDEST', '25.5')],
      );
      const res = await make().verifyByHash(intent, 'e'.repeat(64));
      expect(res.failedOnChain).toBeUndefined();
    });

    it('tolerates clock skew up to the allowance', async () => {
      mockHorizon(
        {
          successful: true,
          memo_type: 'id',
          memo: '123456789',
          created_at: closedAt(-TX_CREATED_AT_SKEW_MS),
        },
        [nativeTo('GDEST', '25.5')],
      );
      const res = await make().verifyByHash(intent, 'e'.repeat(64));
      expect(res.valid).toBe(true);
    });

    it('fails closed on a close time it cannot parse', async () => {
      mockHorizon(
        {
          successful: true,
          memo_type: 'id',
          memo: '123456789',
          created_at: 'not-a-date',
        },
        [nativeTo('GDEST', '25.5')],
      );
      const res = await make().verifyByHash(intent, 'e'.repeat(64));
      expect(res.valid).toBe(false);
    });
  });

  describe('exact amount comparison (integer stroops, not float64)', () => {
    const withAmount = (amount: string) => ({ ...intent, amount });

    it('accepts the same amount written with different trailing zeros', async () => {
      mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GDEST', '25.5000000'),
      ]);
      const res = await make().verifyByHash(withAmount('25.5'), 'e'.repeat(64));
      expect(res.valid).toBe(true);
    });

    it('rejects a one-stroop underpayment at a magnitude float64 cannot resolve', async () => {
      // 92,233,720,368.5477580 vs ...5477581 differ by a single stroop, but
      // both parse to the same double — the old Number() comparison called
      // this a match and settled the intent for one stroop less.
      const expected = '92233720368.5477581';
      const short = '92233720368.5477580';
      expect(Number(short)).toBe(Number(expected));

      mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GDEST', short),
      ]);
      const res = await make().verifyByHash(
        withAmount(expected),
        'f'.repeat(64),
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/No native payment/);
    });

    it('accepts an exact match at that same magnitude', async () => {
      const exact = '92233720368.5477581';
      mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GDEST', exact),
      ]);
      const res = await make().verifyByHash(withAmount(exact), 'a'.repeat(64));
      expect(res.valid).toBe(true);
    });

    it('treats an unparseable amount as a non-match instead of throwing', async () => {
      mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GDEST', 'not-a-number'),
      ]);
      const res = await make().verifyByHash(withAmount('25.5'), 'b'.repeat(64));
      expect(res.valid).toBe(false);
    });

    it('skips the amount check entirely for an open (PAY) intent', async () => {
      mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
        nativeTo('GDEST', '3.1415926'),
      ]);
      const res = await make().verifyByHash(
        { ...intent, amount: null },
        'c'.repeat(64),
      );
      expect(res.valid).toBe(true);
    });
  });
});

describe('StellarVerifierService.findMatchingPayment', () => {
  // Open amount: every native payment to the destination is a candidate, which
  // is what makes a busy address expensive to scan.
  const intent: any = {
    id: 'pi_open',
    network: 'testnet',
    destination: 'GDEST',
    amount: null,
    asset: 'native',
    assetIssuer: null,
    memo: '123456789',
    createdAt: CREATED_AT,
  };

  /**
   * A payment to the destination as a `join=transactions` page carries it: the
   * owning transaction resolves from the record, without a request.
   */
  const paymentAt = (
    hash: string,
    offsetMs: number,
    tx: { successful: boolean; memo?: string } = {
      successful: true,
      memo: '999',
    },
  ) => ({
    ...nativeTo('GDEST', '1'),
    from: 'GPAYER',
    transaction_hash: hash,
    created_at: closedAt(offsetMs),
    transaction: jest.fn(async () => ({ memo_type: 'id', ...tx })),
  });

  /** A full page of dust: newer than the intent, to the destination, someone else's memo. */
  const dustPage = (page: number) =>
    Array.from({ length: PAYMENT_SCAN_PAGE_SIZE }, (_, i) =>
      paymentAt(`h_dust_${page}_${i}`, 10 * 60_000),
    );

  /** `pages[0]` is what `call()` returns; each page's `next()` returns the one after it. */
  function mockScan(pages: any[][]) {
    const next = jest.fn();
    const pageAt = (i: number): any => ({
      records: pages[i] ?? [],
      next: async () => {
        next();
        return pageAt(i + 1);
      },
    });
    const builder: any = {
      forAccount: jest.fn(() => builder),
      join: jest.fn(() => builder),
      order: jest.fn(() => builder),
      limit: jest.fn(() => builder),
      call: jest.fn(async () => pageAt(0)),
    };
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue(builder);
    const transactions = jest.spyOn(Horizon.Server.prototype, 'transactions');
    return { builder, next, transactions };
  }

  afterEach(() => jest.restoreAllMocks());

  it('settles on a recent payment that carries the memo', async () => {
    mockScan([
      [paymentAt('h_new', 5_000, { successful: true, memo: '123456789' })],
    ]);
    const res = await make().findMatchingPayment(intent);
    expect(res).toEqual({ valid: true, txHash: 'h_new', payer: 'GPAYER' });
  });

  it('does not settle on a matching payment whose transaction failed', async () => {
    mockScan([
      [paymentAt('h_new', 5_000, { successful: false, memo: '123456789' })],
    ]);
    const res = await make().findMatchingPayment(intent);
    expect(res.valid).toBe(false);
  });

  it('reads memo and success from transactions joined into the page, not one lookup per candidate', async () => {
    const { builder, transactions } = mockScan([
      [
        paymentAt('h_a', 9_000),
        paymentAt('h_b', 7_000),
        paymentAt('h_new', 5_000, { successful: true, memo: '123456789' }),
      ],
    ]);

    await make().findMatchingPayment(intent);

    expect(builder.join).toHaveBeenCalledWith('transactions');
    expect(builder.order).toHaveBeenCalledWith('desc');
    expect(builder.limit).toHaveBeenCalledWith(PAYMENT_SCAN_PAGE_SIZE);
    expect(transactions).not.toHaveBeenCalled();
  });

  it('stops at the first payment older than the intent, without checking it or paging further', async () => {
    // The page is newest first. The old payment carries the right memo — it is
    // exactly the replay the age floor refuses — and nothing after it can be
    // newer. The page is full, so only the age floor can be what stops it.
    const recent = paymentAt('h_new', 5_000);
    const old = paymentAt('h_old', -TX_CREATED_AT_SKEW_MS - 1_000, {
      successful: true,
      memo: '123456789',
    });
    const older = paymentAt('h_older', -60 * 60_000, {
      successful: true,
      memo: '123456789',
    });
    const filler = Array.from({ length: PAYMENT_SCAN_PAGE_SIZE - 3 }, (_, i) =>
      paymentAt(`h_fill_${i}`, -2 * 60 * 60_000),
    );
    const { next } = mockScan([[recent, old, older, ...filler], dustPage(1)]);

    const res = await make().findMatchingPayment(intent);

    expect(res.valid).toBe(false);
    expect(recent.transaction).toHaveBeenCalledTimes(1);
    expect(old.transaction).not.toHaveBeenCalled();
    expect(older.transaction).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * One page of the 50 newest payments was all the scan read, so payments sent
   * after the real one — dust from anyone — pushed it out of sight and the
   * intent expired although it was paid.
   */
  it('finds a payment pushed off the first page by newer ones', async () => {
    const { next } = mockScan([
      dustPage(0),
      [paymentAt('h_real', 5_000, { successful: true, memo: '123456789' })],
    ]);

    const res = await make().findMatchingPayment(intent);

    expect(res).toEqual({ valid: true, txHash: 'h_real', payer: 'GPAYER' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('asks for no further page after a short one', async () => {
    const { next } = mockScan([[paymentAt('h_new', 5_000)]]);

    const res = await make().findMatchingPayment(intent);

    expect(res).toEqual({
      valid: false,
      reason: 'No matching payment found yet',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it(`gives up after ${PAYMENT_SCAN_MAX_PAGES} full pages, as a miss rather than an error`, async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const pages = Array.from({ length: PAYMENT_SCAN_MAX_PAGES }, (_, i) =>
      dustPage(i),
    );
    // Beyond the bound: never reached.
    pages.push([
      paymentAt('h_beyond', 5_000, { successful: true, memo: '123456789' }),
    ]);
    const { next } = mockScan(pages);

    const res = await make().findMatchingPayment(intent);

    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(
      new RegExp(`${PAYMENT_SCAN_MAX_PAGES * PAYMENT_SCAN_PAGE_SIZE} newest`),
    );
    expect(next).toHaveBeenCalledTimes(PAYMENT_SCAN_MAX_PAGES - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pi_open'));
  });

  it('reports a destination Horizon does not know', async () => {
    const { builder } = mockScan([]);
    builder.call.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { response: { status: 404 } }),
    );

    const res = await make().findMatchingPayment(intent);

    expect(res).toEqual({
      valid: false,
      reason: 'Destination account not found',
    });
  });

  it('rethrows any other Horizon failure, so the observer cannot read it as "no payment"', async () => {
    const { builder } = mockScan([]);
    builder.call.mockRejectedValueOnce(
      Object.assign(new Error('Service Unavailable'), {
        response: { status: 503 },
      }),
    );

    await expect(make().findMatchingPayment(intent)).rejects.toThrow(
      'Service Unavailable',
    );
  });
});
