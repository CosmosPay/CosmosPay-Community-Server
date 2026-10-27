import { paymentLegs } from '@/payment-intents/payment-legs';

const WALLET = 'GBDHAQXQQ75WVBUZ2IX3O7ME7JOKJUOUPUXRNDCORUJODWQCTVUEQ62R';
const record = (paidBy: 'recipient' | 'payer') => ({
  bps: 150,
  fixed: '0.1',
  amount: '0.25',
  asset: 'native',
  wallet: WALLET,
  paidBy,
});

describe('paymentLegs', () => {
  it('is the whole amount to the destination without a merchant fee', () => {
    expect(paymentLegs({ amount: '10', merchantFee: null }, 7)).toEqual({
      destinationAmount: '10',
      fee: null,
    });
    expect(paymentLegs({ amount: null, merchantFee: null }, 7)).toEqual({
      destinationAmount: null,
      fee: null,
    });
  });

  it('takes a fee paid by the recipient out of the amount', () => {
    expect(
      paymentLegs({ amount: '10', merchantFee: record('recipient') }, 7),
    ).toEqual({
      destinationAmount: '9.75',
      fee: { wallet: WALLET, amount: '0.25' },
    });
  });

  it('sends a fee paid by the payer beside the whole amount', () => {
    expect(
      paymentLegs({ amount: '10', merchantFee: record('payer') }, 7),
    ).toEqual({
      destinationAmount: '10',
      fee: { wallet: WALLET, amount: '0.25' },
    });
  });

  it('ignores a column that holds no record', () => {
    expect(paymentLegs({ amount: '10', merchantFee: { bps: 1 } }, 7).fee).toBe(
      null,
    );
  });
});
