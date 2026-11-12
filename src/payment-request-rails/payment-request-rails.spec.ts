import {
  PaymentRequestRails,
  type PaymentRequestLedger,
  type PaymentRequestRail,
  type PaymentRequestTerms,
} from '@/payment-request-rails/payment-request-rails';

const TERMS: PaymentRequestTerms = {
  ownerId: 'c_seller',
  network: 'public',
  currency: 'ARS',
  amount: '15000',
  chainId: 137,
  tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
};
const USDT = { symbol: 'USDT', decimals: 6 };

function rail(accepts: boolean): PaymentRequestRail {
  return {
    method: 'transfer',
    accepts: jest.fn(() => Promise.resolve(accepts ? USDT : null)),
  };
}

const ledger: PaymentRequestLedger = {
  find: jest.fn(),
  markProcessing: jest.fn(),
  markPaid: jest.fn(),
};

describe('PaymentRequestRails', () => {
  it('orders the methods transfer first, then p2p', async () => {
    const rails = new PaymentRequestRails();
    rails.registerRail(rail(true));

    await expect(rails.methodsFor(TERMS, null, true)).resolves.toEqual([
      'transfer',
      'p2p',
    ]);
    await expect(rails.methodsFor(TERMS, null, false)).resolves.toEqual([
      'transfer',
    ]);
    expect(rails.hasRails()).toBe(true);
  });

  it('offers only p2p when no rail is registered or none accepts', async () => {
    const none = new PaymentRequestRails();
    expect(none.hasRails()).toBe(false);
    await expect(none.methodsFor(TERMS, null, true)).resolves.toEqual(['p2p']);
    const rails = new PaymentRequestRails();
    rails.registerRail(rail(false));
    await expect(rails.methodsFor(TERMS, null, true)).resolves.toEqual(['p2p']);
    await expect(rails.methodsFor(TERMS, null, false)).resolves.toEqual([]);
  });

  it('hands each rail the terms and the token the market lists', async () => {
    const rails = new PaymentRequestRails();
    const transfer = rail(true);
    rails.registerRail(transfer);

    await expect(rails.accepting(TERMS, USDT)).resolves.toEqual([
      { method: 'transfer', token: USDT },
    ]);
    expect(transfer.accepts).toHaveBeenCalledWith(TERMS, USDT);
  });

  it('refuses a rail or a ledger registered twice', () => {
    const rails = new PaymentRequestRails();
    rails.registerRail(rail(true));
    rails.registerLedger(ledger);

    expect(() => rails.registerRail(rail(true))).toThrow(/registered twice/);
    expect(() => rails.registerLedger(ledger)).toThrow(/registered twice/);
    expect(rails.ledger()).toBe(ledger);
  });

  it('says so when no plugin owns payment requests', () => {
    expect(() => new PaymentRequestRails().ledger()).toThrow(
      /No payment request ledger/,
    );
  });
});
