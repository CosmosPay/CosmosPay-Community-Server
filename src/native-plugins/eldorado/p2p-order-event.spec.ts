import {
  completionProblem,
  isCompleted,
  readOrderEvent,
} from '@/native-plugins/eldorado/p2p-order-event';

const RECIPIENT = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const TX = `0x${'ab'.repeat(32)}`;
const DEST_TX = `0x${'cd'.repeat(32)}`;

/** A completed purchase, in the shape the marketplace's Orders docs give. */
const ORDER = {
  apiOrderId: 'ord-1',
  orderStatus: 'COMPLETED',
  type: 'BUY',
  externalReferenceId: 'cp-6f1c0e1a-1b2c-4d5e-8f90-123456789abc',
  cryptoDetails: {
    recipientAddress: RECIPIENT.toLowerCase(),
    tokenAddress: USDT0.toLowerCase(),
    chainId: '42161',
  },
  quote: {
    in: { amount: '15000.00', currency: 'ARS' },
    out: { amount: '9.10' },
  },
  transferInfo: {
    amountOut: '8.95',
    txHash: TX,
    txHashDestination: DEST_TX,
    transferDate: '2026-11-12T12:05:00.000Z',
  },
};

const SESSION = {
  side: 'buy',
  address: RECIPIENT,
  chainId: 42161,
  tokenAddress: USDT0,
  currency: 'ARS',
  amount: '15000',
};

describe('readOrderEvent', () => {
  it('finds the order in every envelope the webhook may use', () => {
    for (const body of [
      { event: 'ORDER_STATUS_CHANGED', order: ORDER },
      { eventType: 'ORDER_STATUS_CHANGED', data: { order: ORDER } },
      { data: ORDER },
      ORDER,
    ]) {
      expect(readOrderEvent(body)).toEqual({
        orderId: 'ord-1',
        status: 'COMPLETED',
        type: 'BUY',
        reference: 'cp-6f1c0e1a-1b2c-4d5e-8f90-123456789abc',
        recipientAddress: RECIPIENT.toLowerCase(),
        chainId: 42161,
        tokenAddress: USDT0.toLowerCase(),
        fiatAmount: '15000.00',
        fiatCurrency: 'ARS',
        amountOut: '8.95',
        // The destination chain's transaction when there is one.
        txHash: DEST_TX,
      });
    }
  });

  it('falls back to the transfer’s own hash, and reads an order still in progress', () => {
    const accepted = readOrderEvent({
      order: {
        ...ORDER,
        orderStatus: 'ACCEPTED',
        transferInfo: { txHash: TX },
      },
    });

    expect(accepted).toMatchObject({
      status: 'ACCEPTED',
      txHash: TX,
      amountOut: null,
    });
    expect(isCompleted(accepted!)).toBe(false);
  });

  it('reads nothing from a body with no order status, or another event', () => {
    expect(readOrderEvent(null)).toBeNull();
    expect(readOrderEvent('COMPLETED')).toBeNull();
    expect(readOrderEvent({ order: { apiOrderId: 'x' } })).toBeNull();
    expect(
      readOrderEvent({ event: 'SOMETHING_ELSE', order: ORDER }),
    ).toBeNull();
  });

  it('drops fields that are not what they claim', () => {
    const event = readOrderEvent({
      order: {
        ...ORDER,
        externalReferenceId: 'cp-1; DROP TABLE',
        cryptoDetails: {
          recipientAddress: 'G-not-evm',
          tokenAddress: 42,
          chainId: '0x1',
        },
        quote: { in: { amount: '-1', currency: 'A R S' } },
        transferInfo: { amountOut: 'lots', txHash: 'nope' },
      },
    });

    expect(event).toMatchObject({
      reference: null,
      recipientAddress: null,
      tokenAddress: null,
      chainId: null,
      fiatAmount: null,
      fiatCurrency: null,
      amountOut: null,
      txHash: null,
    });
  });
});

describe('completionProblem', () => {
  const completed = readOrderEvent({ order: ORDER })!;

  it('pays with a completed purchase to the session’s recipient, chain and token, any case', () => {
    expect(completionProblem(completed, SESSION)).toBeNull();
    // More than asked is still paid.
    expect(
      completionProblem({ ...completed, fiatAmount: '15500' }, SESSION),
    ).toBeNull();
  });

  it('pays in the session’s currency whatever its case', () => {
    const lowerCase = readOrderEvent({
      order: { ...ORDER, quote: { in: { amount: '15000', currency: 'ars' } } },
    })!;

    expect(lowerCase.fiatCurrency).toBe('ARS');
    expect(completionProblem(lowerCase, SESSION)).toBeNull();
    expect(
      completionProblem(completed, { ...SESSION, currency: 'ars' }),
    ).toBeNull();
  });

  it('refuses an order paid in another currency, or in none it names', () => {
    // The payer switched the widget to a cheaper currency: the same number of pesos is not the charge.
    const otherCurrency = readOrderEvent({
      order: { ...ORDER, quote: { in: { amount: '15000', currency: 'COP' } } },
    })!;
    const noCurrency = readOrderEvent({
      order: { ...ORDER, quote: { in: { amount: '15000' } } },
    })!;

    expect(completionProblem(otherCurrency, SESSION)).toBe(
      'the order paid in COP, not ARS',
    );
    expect(noCurrency.fiatCurrency).toBeNull();
    expect(completionProblem(noCurrency, SESSION)).toBe(
      'the order carries no currency',
    );
  });

  it('refuses everything else, saying why', () => {
    expect(
      completionProblem({ ...completed, status: 'FIAT_PAID' }, SESSION),
    ).toBe('the order is FIAT_PAID');
    expect(completionProblem({ ...completed, type: 'SELL' }, SESSION)).toBe(
      'the order is SELL, not a purchase',
    );
    expect(completionProblem(completed, { ...SESSION, side: 'sell' })).toBe(
      'the order is BUY, not a purchase',
    );
    expect(
      completionProblem(
        { ...completed, recipientAddress: `0x${'1'.repeat(40)}` },
        SESSION,
      ),
    ).toBe('the order delivered to another recipient');
    expect(completionProblem({ ...completed, chainId: 1 }, SESSION)).toBe(
      'the order delivered on chain 1, not 42161',
    );
    expect(
      completionProblem({ ...completed, tokenAddress: null }, SESSION),
    ).toBe('the order delivered another token');
    expect(completionProblem({ ...completed, fiatAmount: null }, SESSION)).toBe(
      'the order carries no amount paid',
    );
    // The payer changed the amount in the widget.
    expect(
      completionProblem({ ...completed, fiatAmount: '100' }, SESSION),
    ).toBe('the order paid 100, less than 15000');
  });
});
