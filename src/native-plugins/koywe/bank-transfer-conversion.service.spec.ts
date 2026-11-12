import { Logger } from '@nestjs/common';
import { BankTransferConversion } from '@/native-plugins/koywe/bank-transfer-conversion.service';
import { BankTransferOrders } from '@/native-plugins/koywe/bank-transfer-orders.service';
import { BankTransferRail } from '@/native-plugins/koywe/bank-transfer-rail.service';
import { KoyweCryptoAccounts } from '@/native-plugins/koywe/koywe-crypto-accounts.service';
import {
  fakeLedger,
  koyweConfig,
  request,
  SANDBOX_USDT,
  SELLER_ADDRESS,
} from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import {
  koyweDb,
  type Row,
} from '@/native-plugins/koywe/koywe-memory-db.fake-spec';

function setup(requestOver: Parameters<typeof request>[0] = {}) {
  const db = koyweDb();
  const config = koyweConfig();
  const { rails, requests, settlements } = fakeLedger([request(requestOver)]);
  const client = {
    orderByExternalId: jest.fn(() => Promise.resolve(null)),
    searchCryptoAccounts: jest.fn(() => Promise.resolve([])),
    createCryptoAccount: jest.fn(() =>
      Promise.resolve({ id: 'acc_seller', address: SELLER_ADDRESS }),
    ),
    quote: jest.fn(() => Promise.resolve({ id: 'q_1', finalAmountOut: 9.9 })),
    createOrder: jest.fn(() =>
      Promise.resolve({
        id: 'ord_1',
        status: 'PROCESSING',
        policyResult: 'ALLOW',
      } as Row),
    ),
    order: jest.fn(),
  };
  const rail = new BankTransferRail(config as never, rails, {
    forOwner: jest.fn(),
  } as never);
  const orders = new BankTransferOrders(db as never, client as never, rails);
  const service = new BankTransferConversion(
    db as never,
    client as never,
    rails,
    rail,
    new KoyweCryptoAccounts(db as never, client as never),
    orders,
  );
  const transfer: Row = {
    id: 'btr1',
    network: 'public',
    paymentRequestId: 'creq1',
    providerMerchantId: 'mrc_seller',
    providerOrderId: null,
    providerStatus: null,
    status: 'converting',
    depositAmount: '15500',
    instructedAmount: '15000',
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    deliveredAmount: null,
    txHash: null,
    reason: null,
  };
  db.bankTransfer.rows.push(transfer);
  return { db, client, service, transfer, requests, settlements };
}

describe('BankTransferConversion', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('converts the whole deposit under the seller’s merchant and orders it to the seller’s account', async () => {
    const { db, client, service, transfer, requests } = setup();

    await service.convert('btr1');

    expect(requests[0].status).toBe('processing');
    expect(client.searchCryptoAccounts).toHaveBeenCalledWith(
      'public',
      'mrc_seller',
      { currencySymbol: 'USDT', network: 'POLYGON', address: SELLER_ADDRESS },
    );
    expect(client.createCryptoAccount).toHaveBeenCalledWith(
      'public',
      'mrc_seller',
      expect.objectContaining({
        kind: 'CRYPTO',
        address: SELLER_ADDRESS,
        accountNumber: SELLER_ADDRESS,
        routingNumber: '',
        isDefault: false,
        network: 'POLYGON',
        currencySymbol: 'USDT',
      }),
    );
    expect(client.quote).toHaveBeenCalledWith('public', 'mrc_seller', {
      orderType: 'ONRAMP',
      executable: true,
      originCurrencySymbol: 'ARS',
      destinationCurrencySymbol: 'USDT',
      // The whole deposit, not the 15000 instructed.
      amountIn: 15500,
      network: 'POLYGON',
    });
    expect(client.createOrder).toHaveBeenCalledWith('public', 'mrc_seller', {
      type: 'ONRAMP',
      quoteId: 'q_1',
      destinationAccountId: 'acc_seller',
      externalId: 'btr1',
      description: 'Cosmos Pay charge creq1',
    });
    expect(transfer).toMatchObject({
      status: 'converting',
      providerOrderId: 'ord_1',
      providerQuoteId: 'q_1',
      providerStatus: 'PROCESSING',
      reason: null,
      attempts: 1,
      nextAttemptAt: null,
    });
    expect(db.bankTransferCryptoAccount.rows[0]).toMatchObject({
      network: 'public',
      merchantId: 'mrc_seller',
      providerNetwork: 'POLYGON',
      token: 'USDT',
      address: SELLER_ADDRESS.toLowerCase(),
      accountId: 'acc_seller',
    });
  });

  it('reuses the seller’s account: found at the provider, or kept from before', async () => {
    const { client, service, db } = setup();
    client.searchCryptoAccounts.mockResolvedValueOnce([
      { id: 'acc_found', address: SELLER_ADDRESS.toLowerCase() },
    ] as never);

    await service.convert('btr1');

    expect(client.createCryptoAccount).not.toHaveBeenCalled();
    expect(client.createOrder).toHaveBeenCalledWith(
      'public',
      'mrc_seller',
      expect.objectContaining({ destinationAccountId: 'acc_found' }),
    );
    expect(db.bankTransferCryptoAccount.rows[0].accountId).toBe('acc_found');
  });

  it('converts a test request on the sandbox network and token', async () => {
    const { client, service, transfer } = setup({
      network: 'testnet',
      chainId: 421614,
      tokenAddress: SANDBOX_USDT,
      tokenDecimals: 18,
    });
    transfer.network = 'testnet';

    await service.convert('btr1');

    expect(client.quote).toHaveBeenCalledWith(
      'testnet',
      'mrc_seller',
      expect.objectContaining({
        destinationCurrencySymbol: 'USDT',
        network: 'POLYGON',
      }),
    );
  });

  it('keeps an order the approval policy holds converting, with the reason, and logs it for a person', async () => {
    const { client, service, transfer } = setup();
    client.createOrder.mockResolvedValueOnce({
      id: 'ord_1',
      status: 'ON_HOLD',
      policyResult: 'REQUIRE_APPROVALS',
      pendingApprovalId: 'ppa_9',
    });

    await service.convert('btr1');

    expect(transfer).toMatchObject({
      status: 'converting',
      providerOrderId: 'ord_1',
      providerStatus: 'ON_HOLD',
      reason: 'approval policy REQUIRE_APPROVALS (ppa_9)',
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('waits for a person'),
    );
  });

  it('keeps a held account registration converting, and retries it later', async () => {
    const { client, service, transfer } = setup();
    client.createCryptoAccount.mockResolvedValueOnce({
      pendingApprovalId: 'ppa_acc',
    } as never);

    await service.convert('btr1');

    expect(client.quote).not.toHaveBeenCalled();
    expect(transfer).toMatchObject({
      status: 'converting',
      providerOrderId: null,
      providerStatus: 'ACCOUNT_ON_HOLD',
      reason: expect.stringContaining('awaits approval (ppa_acc)'),
      attempts: 1,
    });
    expect((transfer.nextAttemptAt as Date).getTime()).toBeGreaterThan(
      Date.now() + 50_000,
    );
  });

  it('keeps a failed attempt converting, backing off, and finds the first order on the next attempt', async () => {
    const { client, service, transfer } = setup();
    client.createOrder.mockRejectedValueOnce(new Error('the quote expired'));

    await service.convert('btr1');
    expect(transfer).toMatchObject({
      status: 'converting',
      providerOrderId: null,
      reason: 'the quote expired',
      attempts: 1,
    });
    // Not due yet: nothing happens.
    await service.convert('btr1');
    expect(client.quote).toHaveBeenCalledTimes(1);

    // Due again; the provider kept the first order after all.
    transfer.nextAttemptAt = new Date(Date.now() - 1000);
    client.orderByExternalId.mockResolvedValueOnce({
      id: 'ord_1',
      status: 'PROCESSING',
    } as never);
    await service.convert('btr1');
    expect(client.orderByExternalId).toHaveBeenCalledWith(
      'public',
      'mrc_seller',
      'btr1',
    );
    expect(client.quote).toHaveBeenCalledTimes(1);
    expect(transfer).toMatchObject({ providerOrderId: 'ord_1', attempts: 2 });
  });

  it('never runs two attempts at once', async () => {
    const { client, service } = setup();

    await Promise.all([service.convert('btr1'), service.convert('btr1')]);

    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });

  it('completes at once an order that was already completed', async () => {
    const { client, service, transfer, settlements } = setup();
    client.createOrder.mockResolvedValueOnce({
      id: 'ord_1',
      status: 'COMPLETED',
      policyResult: 'ALLOW',
      amountOut: 10.2,
    });

    await service.convert('btr1');

    expect(transfer.status).toBe('completed');
    expect(settlements[0].settlement).toMatchObject({
      method: 'transfer',
      amount: '10.2',
    });
  });

  it('leaves a transfer that is not converting, or already ordered, alone', async () => {
    const { client, service, transfer } = setup();
    transfer.providerOrderId = 'ord_0';
    await service.convert('btr1');
    transfer.providerOrderId = null;
    transfer.status = 'completed';
    await service.convert('btr1');
    await service.convert('btr404');

    expect(client.quote).not.toHaveBeenCalled();
  });
});
