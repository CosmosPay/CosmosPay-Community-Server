import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from '@/stellar/stellar.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import { TX_CREATED_AT_SKEW_MS } from '@/payment-intents/payment-intents.constants';

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

  const paymentAt = (hash: string, offsetMs: number) => ({
    ...nativeTo('GDEST', '1'),
    from: 'GPAYER',
    transaction_hash: hash,
    created_at: closedAt(offsetMs),
  });

  function mockScan(
    records: any[],
    txs: Record<string, { successful: boolean; memo?: string }>,
  ) {
    const transaction = jest.fn((hash: string) => ({
      call: async () => ({ memo_type: 'id', ...txs[hash] }),
    }));
    jest
      .spyOn(Horizon.Server.prototype, 'transactions')
      .mockReturnValue({ transaction } as any);
    const page: any = {
      forAccount: () => page,
      order: () => page,
      limit: () => page,
      call: async () => ({ records }),
    };
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue(page);
    return { transaction };
  }

  afterEach(() => jest.restoreAllMocks());

  it('settles on a recent payment that carries the memo', async () => {
    mockScan([paymentAt('h_new', 5_000)], {
      h_new: { successful: true, memo: '123456789' },
    });
    const res = await make().findMatchingPayment(intent);
    expect(res).toEqual({ valid: true, txHash: 'h_new', payer: 'GPAYER' });
  });

  it('stops at the first payment older than the intent, without looking up its transaction', async () => {
    // The page is newest first. The old payment carries the right memo — it is
    // exactly the replay the age floor refuses — and nothing after it can be
    // newer, so neither it nor anything below it costs a Horizon call.
    const { transaction } = mockScan(
      [
        paymentAt('h_new', 5_000),
        paymentAt('h_old', -TX_CREATED_AT_SKEW_MS - 1_000),
        paymentAt('h_older', -60 * 60_000),
      ],
      {
        h_new: { successful: true, memo: '999' },
        h_old: { successful: true, memo: '123456789' },
        h_older: { successful: true, memo: '123456789' },
      },
    );

    const res = await make().findMatchingPayment(intent);

    expect(res.valid).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith('h_new');
  });
});
