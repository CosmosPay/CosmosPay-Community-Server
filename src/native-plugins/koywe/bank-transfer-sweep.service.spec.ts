import { Logger } from '@nestjs/common';
import { BankTransferSweepService } from '@/native-plugins/koywe/bank-transfer-sweep.service';
import { koyweConfig } from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import {
  koyweDb,
  type Row,
} from '@/native-plugins/koywe/koywe-memory-db.fake-spec';

const MINUTE = 60 * 1000;
const NOW = new Date('2026-11-12T12:00:00.000Z');

function setup() {
  const db = koyweDb();
  const client = {
    isConfigured: jest.fn((network: string) => network === 'public'),
    timeoutMs: 10_000,
  };
  const conversion = { convert: jest.fn((_id: string) => Promise.resolve()) };
  const orders = { refresh: jest.fn((_transfer: Row) => Promise.resolve()) };
  const accounts = { refresh: jest.fn((_account: Row) => Promise.resolve()) };
  const locks = {
    runExclusive: jest.fn((_key: number, work: () => Promise<void>) => work()),
  };
  const sweep = new BankTransferSweepService(
    koyweConfig() as never,
    db as never,
    client as never,
    conversion as never,
    orders as never,
    accounts as never,
    locks as never,
  );
  const transfer = (over: Row) =>
    db.bankTransfer.rows.push({
      network: 'public',
      paymentRequestId: 'creq1',
      providerMerchantId: 'mrc_seller',
      status: 'converting',
      providerOrderId: null,
      nextAttemptAt: null,
      checkedAt: null,
      depositedAt: NOW,
      ...over,
    });
  const account = (over: Row) =>
    db.bankTransferAccount.rows.push({
      network: 'public',
      providerMerchantId: 'mrc_x',
      status: 'pending',
      kybCheckedAt: null,
      cvu: null,
      updatedAt: NOW,
      ...over,
    });
  return { sweep, db, client, conversion, orders, accounts, transfer, account };
}

describe('BankTransferSweepService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('converts the matched deposits whose attempt is due, and no others', async () => {
    const { sweep, conversion, transfer } = setup();
    transfer({ id: 'due' });
    transfer({ id: 'retry', nextAttemptAt: new Date(NOW.getTime() - MINUTE) });
    transfer({ id: 'later', nextAttemptAt: new Date(NOW.getTime() + MINUTE) });
    transfer({ id: 'ordered', providerOrderId: 'ord_1', checkedAt: NOW });
    transfer({ id: 'done', status: 'completed' });
    transfer({ id: 'sandbox', network: 'testnet' });

    await sweep.sweep('public', NOW);

    expect(conversion.convert.mock.calls.map(([id]) => id).sort()).toEqual([
      'due',
      'retry',
    ]);
  });

  it('reads back the orders not finished ten minutes after they were last read', async () => {
    const { sweep, orders, transfer } = setup();
    transfer({
      id: 'stale',
      providerOrderId: 'ord_1',
      checkedAt: new Date(NOW.getTime() - 11 * MINUTE),
    });
    transfer({
      id: 'fresh',
      providerOrderId: 'ord_2',
      checkedAt: new Date(NOW.getTime() - 5 * MINUTE),
    });

    await sweep.sweep('public', NOW);

    expect(orders.refresh).toHaveBeenCalledTimes(1);
    expect(orders.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stale', providerOrderId: 'ord_1' }),
    );
  });

  it('reads back the KYB of pending and in-review accounts every ten minutes, and approved ones without a CVU', async () => {
    const { sweep, accounts, account } = setup();
    account({ id: 'new' });
    account({
      id: 'review',
      status: 'in_review',
      kybCheckedAt: new Date(NOW.getTime() - 11 * MINUTE),
    });
    account({ id: 'recent', kybCheckedAt: new Date(NOW.getTime() - MINUTE) });
    account({ id: 'approved-no-cvu', status: 'approved' });
    account({
      id: 'approved',
      status: 'approved',
      cvu: '0000003100000000000001',
    });
    account({ id: 'rejected', status: 'rejected' });
    account({ id: 'no-merchant', providerMerchantId: null });

    await sweep.sweep('public', NOW);

    expect(accounts.refresh.mock.calls.map(([a]) => a.id).sort()).toEqual([
      'approved-no-cvu',
      'new',
      'review',
    ]);
  });

  it('goes on past an item that fails, and skips an unconfigured network', async () => {
    const { sweep, conversion, transfer } = setup();
    transfer({ id: 'a' });
    transfer({ id: 'b' });
    transfer({ id: 'sandbox', network: 'testnet' });
    conversion.convert.mockRejectedValueOnce(new Error('boom'));

    await sweep.tick();

    expect(conversion.convert).toHaveBeenCalledTimes(2);
    expect(conversion.convert).not.toHaveBeenCalledWith('sandbox');
  });
});
