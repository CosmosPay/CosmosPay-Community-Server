import {
  toMerchantOrderView,
  toOrderView,
  toOrderWebhookData,
  type P2pOrderRow,
} from '@/p2p/p2p-views';

const ROW: P2pOrderRow = {
  id: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10',
  consumerId: 'consumer_client',
  tier: 'testnet',
  kind: 'BUY',
  network: 'base',
  contract: '0x5fbDB2315678afecb367f032d93F642f64180aa3',
  token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  tokenSymbol: 'USDC',
  tokenDecimals: 6,
  merchantAccountId: 'acc_merchant',
  merchantConsumerId: 'consumer_merchant',
  merchantAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  merchantDisplayName: 'Pampa Cambio',
  merchantPaymentMethodId: 'pm_1',
  currency: 'ARS',
  rail: 'ar_bank_transfer',
  price: '1250.5',
  fiatAmount: '125050.00',
  tokenAmount: '100000000',
  netAmount: '99500000',
  protocolFeeBps: 50,
  integratorFeeBps: 25,
  integratorAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  bond: '0',
  acceptWindow: 0,
  paymentWindow: 1800,
  settleWindow: 0,
  openerAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  sellerAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  buyerAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  onchainId: '7',
  status: 'awaiting_payment',
  acceptDeadline: null,
  paymentDeadline: new Date('2026-11-19T12:31:00Z'),
  paidAt: null,
  endedAt: null,
  openTxHash: `0x${'ab'.repeat(32)}`,
  acceptTxHash: null,
  paidTxHash: null,
  releaseTxHash: null,
  cancelTxHash: null,
  disputeTxHash: null,
  resolveTxHash: null,
  settlement: null,
  paidReference: 'TRX-1',
  failureReason: null,
  chargeId: '9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718',
  payoutBatchId: 'batch_1',
  externalReference: 'client-secret-ref-881',
  createdAt: new Date('2026-11-19T12:01:00Z'),
  updatedAt: new Date('2026-11-19T12:01:00Z'),
};

/** What the client keeps for itself: never in anything the merchant reads. */
const CLIENT_ONLY = [
  'externalReference',
  'chargeId',
  'payoutBatchId',
  'integratorFeeBps',
  'integratorAddress',
  'protocolFeeBps',
  'consumerId',
  'merchantConsumerId',
  'merchantPaymentMethodId',
  'openerAddress',
  'failureReason',
  'paymentDetails',
  'merchant',
];

const PERSONAL = ['paymentDetails', 'payer', 'beneficiary'];

describe('P2P views', () => {
  it('gives the merchant webhook exactly the merchant projection’s public keys', () => {
    const body = toOrderWebhookData(ROW, 84532, 'merchant');
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'kind',
        'status',
        'tier',
        'network',
        'chainId',
        'contract',
        'merchantAccountId',
        'merchantSide',
        'token',
        'tokenSymbol',
        'tokenDecimals',
        'currency',
        'rail',
        'price',
        'fiatAmount',
        'tokenAmount',
        'netAmount',
        'bond',
        'sellerAddress',
        'buyerAddress',
        'onchainId',
        'acceptDeadline',
        'paymentDeadline',
        'paidAt',
        'endedAt',
        'txHashes',
        'settlement',
        'paidReference',
        'createdAt',
        'updatedAt',
        'role',
      ].sort(),
    );
    expect(body.role).toBe('merchant');
    for (const key of [...CLIENT_ONLY, ...PERSONAL]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain('client-secret-ref-881');
  });

  it('gives the client webhook its own order, without anyone’s personal details', () => {
    const body = toOrderWebhookData(ROW, 84532, 'client');
    expect(body).toMatchObject({
      role: 'client',
      externalReference: 'client-secret-ref-881',
      chargeId: ROW.chargeId,
      integratorFeeBps: 25,
      merchant: { displayName: 'Pampa Cambio' },
    });
    for (const key of [
      ...PERSONAL,
      'consumerId',
      'merchantConsumerId',
      'merchantAccountId',
      'merchantPaymentMethodId',
      'integratorAddress',
      'openerAddress',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('never shows the merchant the client’s own fields on its order routes', () => {
    const view = toMerchantOrderView(ROW, 84532, {
      payer: { name: 'Juan Gómez', document: '20123456786' },
      beneficiary: null,
    });
    for (const key of CLIENT_ONLY) expect(view).not.toHaveProperty(key);
    expect(view.payer).toEqual({ name: 'Juan Gómez', document: '20123456786' });
  });

  it('shows the counterparty’s details to the merchant only while the order is live', () => {
    const ended = toMerchantOrderView({ ...ROW, status: 'completed' }, 84532, {
      payer: { name: 'Juan Gómez', document: '20123456786' },
      beneficiary: {
        holderName: 'Ana',
        document: '27234567891',
        rail: 'ar_bank_transfer',
        details: {},
      },
    });
    expect(ended.payer).toBeNull();
    expect(ended.beneficiary).toBeNull();
  });

  it('never shows the client the merchant’s internal ids', () => {
    const view = toOrderView(ROW, 84532, null);
    for (const key of [
      'consumerId',
      'merchantConsumerId',
      'merchantAccountId',
      'merchantPaymentMethodId',
      'integratorAddress',
      'openerAddress',
    ]) {
      expect(view).not.toHaveProperty(key);
    }
  });
});
