import { createHmac } from 'node:crypto';
import {
  holdReason,
  keyNames,
  mergeOrders,
  readBankIncome,
  readEnvelope,
  readKybEvent,
  readOrder,
  signatureMatches,
  verifyingNetwork,
} from '@/native-plugins/koywe/koywe-webhook';

const PRODUCTION = 'production-secret-production-secret-1234';
const SANDBOX = 'sandbox-secret-sandbox-secret-sandbox-123';
const BODY = Buffer.from('{"id":"evt_1","type":"webhook.ping"}');
const sign = (secret: string, raw = BODY) =>
  createHmac('sha256', secret).update(raw).digest('hex');

describe('the provider webhook', () => {
  describe('signature', () => {
    it('verifies the lowercase hex HMAC-SHA256 of the raw body, in any case', () => {
      expect(signatureMatches(BODY, sign(SANDBOX), SANDBOX)).toBe(true);
      expect(signatureMatches(BODY, sign(SANDBOX).toUpperCase(), SANDBOX)).toBe(
        true,
      );
    });

    it('refuses a wrong, missing, malformed or other body’s signature', () => {
      expect(signatureMatches(BODY, sign(PRODUCTION), SANDBOX)).toBe(false);
      expect(signatureMatches(BODY, undefined, SANDBOX)).toBe(false);
      expect(signatureMatches(BODY, '', SANDBOX)).toBe(false);
      expect(signatureMatches(BODY, 'zz'.repeat(32), SANDBOX)).toBe(false);
      expect(signatureMatches(BODY, sign(SANDBOX).slice(2), SANDBOX)).toBe(
        false,
      );
      expect(
        signatureMatches(
          Buffer.from(`${BODY.toString()} `),
          sign(SANDBOX),
          SANDBOX,
        ),
      ).toBe(false);
      // No secret configured verifies nothing, not even an empty HMAC.
      expect(signatureMatches(BODY, sign(''), '')).toBe(false);
    });

    it('lets the secret that verifies decide the network', () => {
      const secrets = { public: PRODUCTION, testnet: SANDBOX };

      expect(verifyingNetwork(BODY, sign(PRODUCTION), secrets)).toBe('public');
      expect(verifyingNetwork(BODY, sign(SANDBOX), secrets)).toBe('testnet');
      expect(verifyingNetwork(BODY, sign('a-stranger'), secrets)).toBeNull();
      expect(verifyingNetwork(BODY, undefined, secrets)).toBeNull();
      expect(
        verifyingNetwork(BODY, sign(SANDBOX), {
          public: PRODUCTION,
          testnet: '',
        }),
      ).toBeNull();
    });
  });

  it('reads the envelope, and nothing without an id and a type', () => {
    expect(
      readEnvelope({
        id: 'evt_1',
        type: 'bank_income.received',
        environment: 'sandbox',
        organization_id: 'org_1',
        merchant_id: 'mrc_1',
        data: { amount: 1 },
      }),
    ).toEqual({
      id: 'evt_1',
      type: 'bank_income.received',
      environment: 'sandbox',
      organizationId: 'org_1',
      merchantId: 'mrc_1',
      data: { amount: 1 },
    });
    expect(readEnvelope({ id: 'evt_1', type: 'x', data: [1] })?.data).toEqual(
      {},
    );
    for (const body of [
      null,
      [],
      'evt',
      { type: 'x' },
      { id: 'evt_1' },
      { id: 'e'.repeat(129), type: 'x' },
      { id: 7, type: 'x' },
    ]) {
      expect(readEnvelope(body)).toBeNull();
    }
  });

  describe('a deposit', () => {
    it('reads the amount, currency, document and reference from each place they may be', () => {
      expect(
        readBankIncome({
          amount: 15000,
          currency: 'ars',
          documentNumber: '20123456786',
          referenceId: 'bm_1',
        }),
      ).toEqual({
        amount: '15000',
        currency: 'ARS',
        document: '20123456786',
        reference: 'bm_1',
        missing: [],
      });
      for (const [data, document] of [
        [{ depositor: { documentNumber: '1' } }, '1'],
        [{ payer: { documentNumber: '2' } }, '2'],
        [{ customer: { documentNumber: '3' } }, '3'],
      ] as const) {
        expect(readBankIncome(data).document).toBe(document);
      }
      expect(
        readBankIncome({ amountIn: '15000.50', currencySymbol: 'ARS', id: 42 }),
      ).toMatchObject({ amount: '15000.50', currency: 'ARS', reference: '42' });
    });

    it('says which fields it could not read', () => {
      expect(readBankIncome({}).missing).toEqual([
        'amount',
        'currency',
        'document',
        'reference',
      ]);
      expect(readBankIncome({ amount: 'lots' }).amount).toBeNull();
    });

    it('describes a payload by its key names only, never a value', () => {
      const names = keyNames({
        amount: 15000,
        depositor: { documentNumber: '20123456786', name: 'Juan' },
      });

      expect(names).toBe('amount, depositor{documentNumber,name}');
      expect(names).not.toContain('20123456786');
      expect(keyNames({})).toBe('(none)');
    });
  });

  describe('an order', () => {
    it('reads the order and its transaction from wherever the provider puts it', () => {
      expect(
        readOrder({
          orderId: 'ord_1',
          externalId: 'btr1',
          type: 'onramp',
          status: 'completed',
          amountOut: 8.94,
          transferInfo: { txHash: '0xabc' },
          policyResult: 'ALLOW',
        }),
      ).toEqual({
        orderId: 'ord_1',
        externalId: 'btr1',
        type: 'ONRAMP',
        status: 'COMPLETED',
        amountOut: '8.94',
        txHash: '0xabc',
        policyResult: 'ALLOW',
        pendingApprovalId: null,
      });
      expect(
        readOrder({ id: 'ord_2', transactionHash: '0xdef' }),
      ).toMatchObject({ orderId: 'ord_2', txHash: '0xdef' });
      expect(readOrder({ blockchain: { hash: '0x1' } }).txHash).toBe('0x1');
      expect(readOrder(null)).toMatchObject({ orderId: null, txHash: null });
    });

    it('fills what an event lacks from the order read back', () => {
      const event = readOrder({ orderId: 'ord_1', status: 'COMPLETED' });
      const read = readOrder({ id: 'ord_1', amountOut: 9, txHash: '0x9' });

      expect(mergeOrders(event, read)).toMatchObject({
        orderId: 'ord_1',
        status: 'COMPLETED',
        amountOut: '9',
        txHash: '0x9',
      });
    });

    it('says why an order waits for a person', () => {
      expect(
        holdReason(readOrder({ policyResult: 'ALLOW', status: 'PROCESSING' })),
      ).toBeNull();
      expect(holdReason(readOrder({ status: 'PENDING' }))).toBeNull();
      expect(
        holdReason(
          readOrder({
            policyResult: 'REQUIRE_APPROVALS',
            pendingApprovalId: 'ppa_1',
            status: 'ON_HOLD',
          }),
        ),
      ).toBe('approval policy REQUIRE_APPROVALS (ppa_1)');
      expect(holdReason(readOrder({ status: 'ON_HOLD' }))).toBe(
        'order on hold',
      );
      expect(holdReason(readOrder({ policyResult: 'DENY' }))).toBe(
        'approval policy DENY',
      );
    });
  });

  it('reads a KYB event', () => {
    expect(
      readKybEvent({
        merchantId: 'mrc_1',
        kybId: 'kyb_1',
        statusReason: 'blurry',
      }),
    ).toEqual({ merchantId: 'mrc_1', kybId: 'kyb_1', reason: 'blurry' });
    expect(readKybEvent({})).toEqual({
      merchantId: null,
      kybId: null,
      reason: null,
    });
  });
});
