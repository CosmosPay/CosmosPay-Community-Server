import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ApiErrorCode } from '@/common/errors/api-error';
import { BankIncomeService } from '@/native-plugins/koywe/bank-income.service';
import { documentHash } from '@/native-plugins/koywe/bank-transfer-document';
import { BankTransferWebhooks } from '@/native-plugins/koywe/bank-transfer-webhooks.service';
import {
  fakeLedger,
  koyweConfig,
  PEPPER,
  request,
} from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import { koyweDb } from '@/native-plugins/koywe/koywe-memory-db.fake-spec';

const settings = koyweConfig().koywe;
const SANDBOX_SECRET = settings.environments.testnet.webhookSecret;
const PRODUCTION_SECRET = settings.environments.public.webhookSecret;

function signed(body: unknown, secret = SANDBOX_SECRET) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    signature: createHmac('sha256', secret).update(rawBody).digest('hex'),
  };
}

function setup() {
  const db = koyweDb();
  const config = koyweConfig();
  const { rails, requests, ledger } = fakeLedger([
    request({ network: 'testnet' }),
  ]);
  const client = {
    organizationId: jest.fn((network: string) =>
      network === 'public' ? 'org_production' : 'org_sandbox',
    ),
  };
  const income = new BankIncomeService(config as never, db as never);
  const conversion = { convert: jest.fn(() => Promise.resolve()) };
  const orders = { onEvent: jest.fn(() => Promise.resolve()) };
  const accounts = { applyKyb: jest.fn(() => Promise.resolve()) };
  const webhooks = new BankTransferWebhooks(
    config as never,
    db as never,
    client as never,
    income,
    conversion as never,
    orders as never,
    accounts as never,
    rails,
  );
  db.bankTransfer.rows.push({
    id: 'btr1',
    paymentRequestId: 'creq1',
    network: 'testnet',
    providerMerchantId: 'mrc_seller',
    documentHash: documentHash(PEPPER, '12345678'),
    status: 'awaiting_deposit',
    instructedAmount: '15000',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  });
  return { db, webhooks, conversion, orders, accounts, requests, ledger };
}

const envelope = (
  type: string,
  data: Record<string, unknown> = {},
  over = {},
) => ({
  id: `evt_${type}_${Math.random().toString(36).slice(2)}`,
  type,
  version: 'v1',
  occurred_at: '2026-11-12T12:00:00Z',
  source: 'koywe.api',
  environment: 'sandbox',
  organization_id: 'org_sandbox',
  merchant_id: 'mrc_seller',
  data,
  ...over,
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; getStatus(): number };
  }
  throw new Error('expected the delivery to be refused');
}

describe('BankTransferWebhooks', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a missing, wrong or other body’s signature with 401, storing nothing', async () => {
    const { webhooks, db } = setup();
    const body = envelope('webhook.ping');
    const good = signed(body);

    for (const delivery of [
      { rawBody: good.rawBody, signature: undefined },
      {
        rawBody: good.rawBody,
        signature: signed(body, 'a-stranger').signature,
      },
      {
        rawBody: Buffer.from(`${good.rawBody.toString()} `),
        signature: good.signature,
      },
      { rawBody: undefined, signature: good.signature },
    ]) {
      const error = await failure(webhooks.receive(delivery));
      expect(error.code).toBe(ApiErrorCode.WebhookSignatureInvalid);
      expect(error.getStatus()).toBe(401);
    }
    expect(db.bankTransferWebhookEvent.rows).toHaveLength(0);
  });

  it('acknowledges a ping, and anything it does not act on, without storing it', async () => {
    const { webhooks, db } = setup();

    for (const type of [
      'webhook.ping',
      'merchant.created',
      'policy.approval.requested',
    ]) {
      await expect(webhooks.receive(signed(envelope(type)))).resolves.toEqual({
        received: true,
      });
    }
    expect(db.bankTransferWebhookEvent.rows).toHaveLength(0);
  });

  it('acknowledges a signed body it cannot read, or for another organization, and ignores it', async () => {
    const { webhooks, orders } = setup();
    const notJson = Buffer.from('not json');

    await expect(
      webhooks.receive({
        rawBody: notJson,
        signature: createHmac('sha256', SANDBOX_SECRET)
          .update(notJson)
          .digest('hex'),
      }),
    ).resolves.toEqual({ received: true });
    await webhooks.receive(signed({ type: 'order.completed' }));
    await webhooks.receive(
      signed(
        envelope('order.completed', {}, { organization_id: 'org_stranger' }),
      ),
    );
    await webhooks.settled();

    expect(orders.onEvent).not.toHaveBeenCalled();
  });

  it('matches a deposit before answering, marks the request processing, then converts', async () => {
    const { webhooks, db, conversion, requests } = setup();
    const deposit = envelope('bank_income.received', {
      amount: 15000,
      currency: 'ARS',
      documentNumber: '20123456786',
      referenceId: 'bm_1',
    });

    await webhooks.receive(signed(deposit));

    expect(db.bankTransfer.rows[0].status).toBe('converting');
    expect(requests[0].status).toBe('processing');
    await webhooks.settled();
    expect(conversion.convert).toHaveBeenCalledWith('btr1');
    expect(db.bankTransferWebhookEvent.rows[0]).toMatchObject({
      id: deposit.id,
      network: 'testnet',
      processedAt: expect.any(Date),
    });

    // A redelivery changes nothing and starts nothing.
    await webhooks.receive(signed(deposit));
    await webhooks.settled();
    expect(conversion.convert).toHaveBeenCalledTimes(1);
    expect(db.bankIncomeEvent.rows).toHaveLength(1);
  });

  it('lets the production secret decide the network', async () => {
    const { webhooks, db } = setup();
    const deposit = envelope(
      'bank_income.received',
      { amount: 15000, currency: 'ARS', documentNumber: '12345678' },
      { environment: 'production', organization_id: 'org_production' },
    );

    await webhooks.receive(signed(deposit, PRODUCTION_SECRET));

    expect(db.bankIncomeEvent.rows[0]).toMatchObject({
      network: 'public',
      outcome: 'unmatched',
    });
    // The sandbox's transfer was not touched by a production delivery.
    expect(db.bankTransfer.rows[0].status).toBe('awaiting_deposit');
  });

  it('answers 5xx (so the provider delivers again) only when the delivery cannot be stored', async () => {
    const { webhooks, db, orders } = setup();
    db.bankTransferWebhookEvent.create.mockRejectedValueOnce(
      new Error('the database is down'),
    );

    await expect(
      webhooks.receive(signed(envelope('order.completed'))),
    ).rejects.toThrow('the database is down');
    expect(orders.onEvent).not.toHaveBeenCalled();
  });

  it('applies an order event once, after answering, whatever happens to it', async () => {
    const { webhooks, orders, db } = setup();
    const completed = envelope('order.completed', { orderId: 'ord_1' });
    orders.onEvent.mockRejectedValueOnce(new Error('provider down'));

    await webhooks.receive(signed(completed));
    await webhooks.receive(signed(completed));
    await webhooks.settled();

    expect(orders.onEvent).toHaveBeenCalledTimes(1);
    expect(orders.onEvent).toHaveBeenCalledWith(
      'testnet',
      expect.objectContaining({ id: completed.id, type: 'order.completed' }),
    );
    // Its work failed: not marked processed (the sweep reads the order back).
    expect(db.bankTransferWebhookEvent.rows[0].processedAt).toBeNull();
  });

  it('hands a KYB outcome to the seller’s account', async () => {
    const { webhooks, accounts } = setup();

    await webhooks.receive(
      signed(envelope('merchant.kyb.approved', { kybId: 'kyb_1' })),
    );
    await webhooks.receive(
      signed(
        envelope(
          'merchant.kyb.rejected',
          { merchantId: 'mrc_2', statusReason: 'document unreadable' },
          { merchant_id: undefined },
        ),
      ),
    );
    await webhooks.settled();

    expect(accounts.applyKyb).toHaveBeenCalledWith(
      'testnet',
      'mrc_seller',
      'approved',
      expect.objectContaining({ kybId: 'kyb_1' }),
    );
    expect(accounts.applyKyb).toHaveBeenCalledWith(
      'testnet',
      'mrc_2',
      'rejected',
      expect.objectContaining({ reason: 'document unreadable' }),
    );
  });
});
