import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from '@/stellar/stellar.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';

describe('StellarVerifierService.verifyByHash', () => {
  const intent: any = {
    id: 'pi_1',
    network: 'testnet',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123456789',
  };
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

  function mockHorizon(
    tx: { successful: boolean; memo_type?: string; memo?: string },
    paymentRecords: any[],
  ) {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({ call: async () => tx }),
    } as any);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: () => ({
        call: async () => ({ records: paymentRecords }),
      }),
    } as any);
  }

  const nativeTo = (to: string, amount: string) => ({
    type: 'payment',
    asset_type: 'native',
    to,
    amount,
  });

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

  it('marks a failed on-chain tx as not valid', async () => {
    mockHorizon({ successful: false }, []);
    const res = await make().verifyByHash(intent, 'd'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('Transaction failed on-chain');
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
