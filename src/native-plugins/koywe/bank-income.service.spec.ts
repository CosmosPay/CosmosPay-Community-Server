import { Logger } from '@nestjs/common';
import { BankIncomeService } from '@/native-plugins/koywe/bank-income.service';
import { documentHash } from '@/native-plugins/koywe/bank-transfer-document';
import type { KoyweEnvelope } from '@/native-plugins/koywe/koywe-webhook';
import {
  koyweConfig,
  PEPPER,
} from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import {
  koyweDb,
  type Row,
} from '@/native-plugins/koywe/koywe-memory-db.fake-spec';

const HOUR = 60 * 60 * 1000;
const BUYER = documentHash(PEPPER, '12345678');
const OTHER = documentHash(PEPPER, '87654321');

function setup() {
  const db = koyweDb();
  const service = new BankIncomeService(koyweConfig() as never, db as never);
  let created = 0;
  /** An open transfer, `ageMs` old. */
  const transfer = (over: Row = {}, ageMs = 0) => {
    created += 1;
    const row: Row = {
      id: `btr${created}`,
      paymentRequestId: `creq${created}`,
      network: 'public',
      providerMerchantId: 'mrc_seller',
      documentHash: BUYER,
      documentHint: '786',
      currency: 'ARS',
      amount: '15000',
      instructedAmount: '15000',
      status: 'awaiting_deposit',
      expiresAt: new Date(Date.now() + HOUR),
      attempts: 0,
      providerOrderId: null,
      createdAt: new Date(Date.now() - ageMs),
      ...over,
    };
    db.bankTransfer.rows.push(row);
    return row;
  };
  return { db, service, transfer };
}

let next = 0;
function deposit(
  amount: unknown,
  over: Partial<KoyweEnvelope> = {},
  data: Record<string, unknown> = {},
): KoyweEnvelope {
  next += 1;
  return {
    id: `evt_${next}`,
    type: 'bank_income.received',
    environment: 'production',
    organizationId: 'org_production',
    merchantId: 'mrc_seller',
    data: {
      amount,
      currency: 'ARS',
      documentNumber: '20-12345678-6',
      referenceId: `bm_${next}`,
      ...data,
    },
    ...over,
  };
}

describe('BankIncomeService', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('matches the depositor’s transfer asking exactly the deposit, and records it without the document', async () => {
    const { db, service, transfer } = setup();
    const open = transfer();

    const recorded = await service.record('public', deposit(15000));

    expect(recorded).toEqual({
      duplicate: false,
      outcome: 'matched',
      transfer: { id: open.id, paymentRequestId: open.paymentRequestId },
    });
    expect(open).toMatchObject({
      status: 'converting',
      depositAmount: '15000',
      depositReference: expect.stringMatching(/^bm_/),
      nextAttemptAt: expect.any(Date),
    });
    expect(db.bankIncomeEvent.rows[0]).toMatchObject({
      outcome: 'matched',
      network: 'public',
      merchantId: 'mrc_seller',
      amount: '15000',
      currency: 'ARS',
      documentHash: BUYER,
      documentHint: '786',
      transferId: open.id,
    });
    expect(JSON.stringify(db.bankIncomeEvent.rows)).not.toContain('12345678');
    expect(db.bankTransferWebhookEvent.rows[0]).toMatchObject({
      network: 'public',
      type: 'bank_income.received',
    });
  });

  describe('two open charges of one buyer at one seller', () => {
    it('lets an exact amount pick its charge, whatever the order', async () => {
      const { service, transfer } = setup();
      const fifteen = transfer({}, 2 * HOUR);
      const twenty = transfer({ amount: '20000', instructedAmount: '20000' });

      await service.record('public', deposit(20000));

      expect(twenty.status).toBe('converting');
      expect(fifteen.status).toBe('awaiting_deposit');
    });

    it('sends a larger deposit that could pay either to ops', async () => {
      const { db, service, transfer } = setup();
      const fifteen = transfer({}, 2 * HOUR);
      const twenty = transfer({ amount: '20000', instructedAmount: '20000' });

      const recorded = await service.record('public', deposit(25000));

      expect(recorded.outcome).toBe('unmatched');
      expect([fifteen.status, twenty.status]).toEqual([
        'awaiting_deposit',
        'awaiting_deposit',
      ]);
      expect(db.bankIncomeEvent.rows[0]).toMatchObject({
        outcome: 'unmatched',
        reason:
          'no open transfer asks exactly this amount, and 2 could take it',
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('refund it by hand'),
      );
    });

    it('tells two charges of the same amount apart by the cents the second one asks', async () => {
      const { service, transfer } = setup();
      const first = transfer({}, HOUR);
      const second = transfer({ instructedAmount: '15000.01' });

      await service.record('public', deposit('15000.01'));
      expect(second.status).toBe('converting');
      expect(first.status).toBe('awaiting_deposit');

      await service.record('public', deposit(15000));
      expect(first.status).toBe('converting');
    });
  });

  it('takes an overpayment when the buyer has one open transfer there, converting the whole deposit', async () => {
    const { service, transfer } = setup();
    const only = transfer();

    await service.record('public', deposit(15500));

    expect(only).toMatchObject({
      status: 'converting',
      depositAmount: '15500',
      instructedAmount: '15000',
    });
  });

  it('matches only the merchant the deposit landed in: in pooled mode, two sellers’ charges are one set', async () => {
    const { service, transfer } = setup();
    // Two sellers, one pooled merchant, the same buyer.
    const sellerA = transfer({ providerMerchantId: 'mrc_pool' }, HOUR);
    const sellerB = transfer({
      providerMerchantId: 'mrc_pool',
      amount: '20000',
      instructedAmount: '20000',
    });
    const elsewhere = transfer({ providerMerchantId: 'mrc_other' });

    const larger = await service.record(
      'public',
      deposit(30000, { merchantId: 'mrc_pool' }),
    );
    expect(larger.outcome).toBe('unmatched');

    await service.record('public', deposit(15000, { merchantId: 'mrc_pool' }));
    expect(sellerA.status).toBe('converting');
    expect(sellerB.status).toBe('awaiting_deposit');
    expect(elsewhere.status).toBe('awaiting_deposit');

    // Another merchant's deposit never reaches the pool's transfers.
    const stray = await service.record(
      'public',
      deposit(20000, { merchantId: 'mrc_nobody' }),
    );
    expect(stray.outcome).toBe('unmatched');
    expect(sellerB.status).toBe('awaiting_deposit');
  });

  it('matches a late deposit within a day of expiry, not after', async () => {
    const { service, transfer } = setup();
    const late = transfer({ expiresAt: new Date(Date.now() - 23 * HOUR) });
    const tooLate = transfer({
      documentHash: OTHER,
      expiresAt: new Date(Date.now() - 25 * HOUR),
    });

    await service.record('public', deposit(15000));
    const after = await service.record(
      'public',
      deposit(15000, {}, { documentNumber: '87654321' }),
    );

    expect(late.status).toBe('converting');
    expect(tooLate.status).toBe('awaiting_deposit');
    expect(after.outcome).toBe('unmatched');
  });

  it('never matches another document, a short deposit, another network, or a transfer no longer awaiting', async () => {
    const { service, transfer } = setup();
    const open = transfer();
    const converting = transfer({
      status: 'converting',
      instructedAmount: '16000',
      depositAmount: '16000',
    });

    for (const [network, envelope] of [
      ['public', deposit(15000, {}, { documentNumber: '87654321' })],
      ['public', deposit(14999.99)],
      ['testnet', deposit(15000)],
    ] as const) {
      const recorded = await service.record(network, envelope);
      expect(recorded.outcome).toBe('unmatched');
    }
    expect(open.status).toBe('awaiting_deposit');
    expect(converting.depositAmount).toBe('16000');
  });

  it('ignores a deposit that is not in ARS or has no amount, and keeps one with no document or merchant for ops', async () => {
    const { db, service, transfer } = setup();
    transfer();

    const usd = await service.record(
      'public',
      deposit(15000, {}, { currency: 'USD' }),
    );
    const noAmount = await service.record('public', deposit(undefined));
    const noDocument = await service.record(
      'public',
      deposit(15000, {}, { documentNumber: undefined }),
    );
    const noMerchant = await service.record(
      'public',
      deposit(15000, { merchantId: null }),
    );

    expect(
      [usd, noAmount, noDocument, noMerchant].map((r) => r.outcome),
    ).toEqual(['ignored', 'ignored', 'unmatched', 'unmatched']);
    expect(db.bankIncomeEvent.rows.map((r) => r.reason)).toEqual([
      'currency USD',
      'no amount',
      'no depositor document',
      'no merchant',
    ]);
  });

  it('records a redelivery once and changes nothing the second time', async () => {
    const { db, service, transfer } = setup();
    const open = transfer();
    transfer({ instructedAmount: '15000.01' });
    const delivery = deposit(15000);

    await service.record('public', delivery);
    const again = await service.record('public', delivery);

    expect(again).toEqual({ duplicate: true, outcome: null, transfer: null });
    expect(db.bankIncomeEvent.rows).toHaveLength(1);
    expect(open.status).toBe('converting');
  });

  it('fails, so the provider delivers again, when the deposit cannot be stored', async () => {
    const { db, service } = setup();
    db.bankTransferWebhookEvent.create.mockRejectedValueOnce(
      new Error('the database is down'),
    );

    await expect(service.record('public', deposit(15000))).rejects.toThrow(
      'the database is down',
    );
  });
});
