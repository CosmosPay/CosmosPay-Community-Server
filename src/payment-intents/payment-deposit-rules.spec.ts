import type { PaymentDeposit } from '@generated/prisma/client';
import {
  acceptsCrossChainPayment,
  crossChainPaymentRefusal,
  linkAssetRequest,
  paidFromRecord,
  readPaidFrom,
  settlementRefusal,
  toPaymentDepositEntity,
} from '@/payment-intents/payment-deposit-rules';

const PAYABLE = {
  kind: 'PAY' as const,
  chain: 'base',
  network: 'public',
  amount: '25',
  merchantFee: null,
  crossChainFeeBps: 50,
};

function deposit(overrides: Partial<PaymentDeposit> = {}): PaymentDeposit {
  return {
    id: 'dep_1',
    intentId: 'pi_1',
    network: 'public',
    status: 'AWAITING_DEPOSIT',
    providerStatus: 'PENDING_DEPOSIT',
    originChain: 'tron',
    originAsset: 'USDT',
    originAssetId:
      'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    originContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    originDecimals: 6,
    destinationChain: 'base',
    destinationAsset: 'USDC',
    destinationAssetId:
      'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    destinationContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationDecimals: 6,
    amountIn: '25.28',
    minAmountIn: '25.03',
    amountOut: '25',
    feeBps: 50,
    feeAmount: '0.1264',
    slippageBps: 100,
    recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    refundTo: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy',
    depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
    depositMemo: null,
    depositUri: null,
    amountOutPaid: null,
    refundedAmount: null,
    originTxHashes: null,
    destinationTxHashes: null,
    timeEstimateSeconds: 82,
    correlationId: 'corr-secret',
    quoteSignature: 'ed25519:signature-secret',
    quote: { secret: true },
    expiresAt: new Date('2026-11-16T15:45:00.000Z'),
    lastCheckedAt: null,
    createdAt: new Date('2026-11-16T15:15:00.000Z'),
    updatedAt: new Date('2026-11-16T15:15:00.000Z'),
    ...overrides,
  };
}

describe('crossChainPaymentRefusal', () => {
  it('accepts a mainnet payment link with an amount, no merchant fee and a recorded rate', () => {
    expect(crossChainPaymentRefusal(PAYABLE)).toBeNull();
    expect(acceptsCrossChainPayment(PAYABLE)).toBe(true);
    // A rate of zero is a rate: the plan charges nothing.
    expect(acceptsCrossChainPayment({ ...PAYABLE, crossChainFeeBps: 0 })).toBe(
      true,
    );
  });

  it.each([
    ['a transaction intent', { kind: 'TX' as const }, /known payer/],
    ['a test network', { network: 'testnet' }, /test network/],
    ['an open amount', { amount: null }, /no fixed amount/],
    [
      'a merchant fee',
      {
        merchantFee: {
          bps: 100,
          fixed: '0',
          amount: '0.25',
          asset: 'USDC',
          wallet: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
          paidBy: 'recipient',
        },
      },
      /merchant fee/,
    ],
    ['no recorded rate', { crossChainFeeBps: null }, /without payments/],
    ['an unknown network', { chain: 'qtc' }, /unknown network/],
  ])('refuses %s', (_label, overrides, reason) => {
    expect(crossChainPaymentRefusal({ ...PAYABLE, ...overrides })).toMatch(
      reason,
    );
  });
});

describe('linkAssetRequest', () => {
  it('asks for the native coin, a Stellar CODE:ISSUER or the contract, never a bare symbol', () => {
    expect(
      linkAssetRequest({ chain: 'base', asset: 'native', assetIssuer: null }),
    ).toBe('native');
    expect(
      linkAssetRequest({
        chain: 'stellar',
        asset: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      }),
    ).toBe('USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
    expect(
      linkAssetRequest({
        chain: 'base',
        asset: 'USDC',
        assetIssuer: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      }),
    ).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });
});

describe('toPaymentDepositEntity', () => {
  it('answers the contract fields and never the stored quote', () => {
    const entity = toPaymentDepositEntity(
      deposit({
        destinationTxHashes: [
          { hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' },
          'not a transaction',
        ],
      }),
      'data:image/png;base64,QR',
    );
    const json = JSON.stringify(entity);
    expect(json).not.toContain('secret');
    expect(entity).toMatchObject({
      id: 'dep_1',
      paymentLinkId: 'pi_1',
      amountIn: '25.28',
      amountOut: '25',
      qr: 'data:image/png;base64,QR',
      expiresAt: '2026-11-16T15:45:00.000Z',
      destinationTxHashes: [
        { hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' },
      ],
    });
    expect(Object.keys(entity)).not.toContain('quote');
    expect(Object.keys(entity)).not.toContain('correlationId');
  });
});

describe('settlementRefusal', () => {
  const payout = [
    { hash: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc' },
  ];

  it('settles on a reported payout of at least the link amount', () => {
    expect(
      settlementRefusal(deposit({ amountOutPaid: '25' }), payout),
    ).toBeNull();
    expect(
      settlementRefusal(deposit({ amountOutPaid: '25.000001' }), payout),
    ).toBeNull();
  });

  it('refuses a payout below the link amount, a missing one or no transaction', () => {
    expect(
      settlementRefusal(deposit({ amountOutPaid: '24.99' }), payout),
    ).toMatch(/below/);
    expect(settlementRefusal(deposit(), payout)).toMatch(/no paid amount/);
    expect(settlementRefusal(deposit({ amountOutPaid: '25' }), null)).toMatch(
      /no payout transaction/,
    );
    expect(settlementRefusal(deposit({ amountOutPaid: 'x' }), payout)).toMatch(
      /cannot be read/,
    );
  });
});

describe('paidFrom', () => {
  it('records what the payer sent and reads it back', () => {
    const record = paidFromRecord(deposit());
    expect(record).toEqual({
      depositId: 'dep_1',
      chain: 'tron',
      asset: 'USDT',
      contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amount: '25.28',
    });
    expect(readPaidFrom(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(readPaidFrom(null)).toBeNull();
    expect(readPaidFrom({ depositId: 1 })).toBeNull();
  });
});
