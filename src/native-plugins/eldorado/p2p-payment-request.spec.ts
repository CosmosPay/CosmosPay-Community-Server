import {
  effectiveStatus,
  P2P_PAYMENT_REQUEST_PAYER_SELECT,
  paymentRequestUrl,
  toPublicPaymentRequest,
} from '@/native-plugins/eldorado/p2p-payment-request';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const LATER = new Date('2026-11-13T12:00:00.000Z');

/** A full row, as a careless caller might hand it over: owner, seller and payment included. */
const FULL_ROW = {
  id: 'cmh4x2k9a0001l70g8v5q3z2w',
  consumerId: 'c_seller',
  sharedPublicKey: true,
  network: 'public',
  status: 'open',
  currency: 'ARS',
  amount: '16000',
  chainId: 42161,
  token: 'USDT0',
  tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  tokenDecimals: 6,
  address: '0x52908400098527886E0F7030069857D2E4169EE7',
  description: 'Table 4',
  estimatedAmountOut: '9.00',
  expiresAt: LATER,
  createdAt: NOW,
  paidAt: null,
  paidAmount: '9.95',
  paidTxHash: `0x${'ab'.repeat(32)}`,
  paidSessionId: 'clz_s1',
  cancelledAt: null,
  updatedAt: NOW,
};

const LIVE = {
  currency: {
    id: 'ARS',
    name: 'Argentine Pesos',
    price: '1600',
    minAmount: '8000',
    paymentMethods: [{ id: 'bank_tx_ar', name: 'CVU/CBU o Alias (ARS)' }],
  },
  token: {
    chainId: 42161,
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    symbol: 'USDT0',
    decimals: 6,
    priceUsd: '1',
    logoUrl: null,
    main: true,
  },
};

describe('payment request rules', () => {
  it('reads an open request past its expiry as expired, and nothing else differently', () => {
    const row = { id: 'r1', status: 'open', expiresAt: LATER };

    expect(effectiveStatus(row, NOW)).toBe('open');
    expect(effectiveStatus(row, LATER)).toBe('expired');
    for (const status of ['paid', 'cancelled'] as const) {
      expect(effectiveStatus({ ...row, status }, LATER)).toBe(status);
    }
    // `expired` is never stored, and nothing else may be.
    expect(() => effectiveStatus({ ...row, status: 'expired' }, NOW)).toThrow(
      'Payment request r1 has unknown status "expired"',
    );
  });

  it('builds the payer page under the payments origin', () => {
    expect(paymentRequestUrl('https://payments.cosmospay.lat', 'r1')).toBe(
      'https://payments.cosmospay.lat/fiat/r1',
    );
    expect(paymentRequestUrl('https://payments.cosmospay.lat/', 'r1')).toBe(
      'https://payments.cosmospay.lat/fiat/r1',
    );
  });

  it('never loads the owner, the seller’s address or the payment for the payer', () => {
    const loaded = Object.keys(P2P_PAYMENT_REQUEST_PAYER_SELECT);

    for (const hidden of [
      'consumerId',
      'sharedPublicKey',
      'address',
      'paidAmount',
      'paidTxHash',
      'paidSessionId',
      'estimatedAmountOut',
    ]) {
      expect(loaded).not.toContain(hidden);
    }
  });

  it('answers the payer exactly the public fields, whatever row it is handed', () => {
    const view = toPublicPaymentRequest(FULL_ROW, LIVE, NOW);

    expect(view).toEqual({
      id: FULL_ROW.id,
      network: 'public',
      status: 'open',
      currency: 'ARS',
      amount: '16000',
      description: 'Table 4',
      chainId: 42161,
      token: 'USDT0',
      tokenAddress: FULL_ROW.tokenAddress,
      // Live: 16000 / 1600 / 1, not the stored estimate.
      estimatedAmountOut: '10.00',
      paymentMethods: [{ id: 'bank_tx_ar', name: 'CVU/CBU o Alias (ARS)' }],
      expiresAt: '2026-11-13T12:00:00.000Z',
      createdAt: '2026-11-12T12:00:00.000Z',
      paidAt: null,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain(FULL_ROW.address);
    expect(text).not.toContain(FULL_ROW.paidTxHash);
    expect(text).not.toContain('c_seller');
  });

  it('leaves the estimate and the methods empty when the market cannot say', () => {
    const view = toPublicPaymentRequest(
      FULL_ROW,
      { currency: null, token: null },
      LATER,
    );

    expect(view).toMatchObject({
      status: 'expired',
      estimatedAmountOut: null,
      paymentMethods: [],
    });
    expect(
      toPublicPaymentRequest(
        FULL_ROW,
        { currency: LIVE.currency, token: null },
        NOW,
      ).estimatedAmountOut,
    ).toBeNull();
  });
});
