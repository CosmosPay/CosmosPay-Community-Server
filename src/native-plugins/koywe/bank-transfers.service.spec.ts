import { Logger } from '@nestjs/common';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { documentHash } from '@/native-plugins/koywe/bank-transfer-document';
import { BankTransferRail } from '@/native-plugins/koywe/bank-transfer-rail.service';
import { BankTransfersService } from '@/native-plugins/koywe/bank-transfers.service';
import {
  fakeLedger,
  koyweConfig,
  PEPPER,
  request,
  SANDBOX_USDT,
} from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import { koyweDb } from '@/native-plugins/koywe/koywe-memory-db.fake-spec';
import type { PaymentRequestRecord } from '@/payment-request-rails/payment-request-rails';

const HOUR = 60 * 60 * 1000;

const APPROVED = {
  id: 'acct1',
  network: 'public',
  type: 'person',
  name: 'Juan Pérez',
  status: 'approved',
  reason: null,
  verificationUrl: null,
  providerMerchantId: 'mrc_seller',
  kybId: 'kyb_1',
  kybCheckedAt: null,
  alias: 'juan.perez.cp',
  cvu: '0000003100000000000001',
  bank: 'A bank',
  updatedAt: new Date(),
};

function setup(
  options: {
    requests?: PaymentRequestRecord[];
    account?: typeof APPROVED | null;
    koywe?: Partial<AppConfig['koywe']>;
  } = {},
) {
  const db = koyweDb();
  const config = koyweConfig(options.koywe);
  const { rails, requests } = fakeLedger(
    options.requests ?? [
      request(),
      request({ id: 'creq2' }),
      request({ id: 'creq3' }),
    ],
  );
  const accounts = {
    forOwner: jest.fn(() =>
      Promise.resolve(
        options.account === undefined ? APPROVED : options.account,
      ),
    ),
  };
  const rail = new BankTransferRail(config as never, rails, accounts as never);
  rails.registerRail(rail);
  const pooled = {
    instructions: jest.fn(() =>
      Promise.resolve({
        alias: 'cosmospay.qr',
        cvu: '0000003100000000000000',
        holder: 'Cosmos Pay',
        bank: null,
      }),
    ),
  };
  const service = new BankTransfersService(
    config as never,
    db as never,
    rails,
    rail,
    pooled as never,
  );
  return { db, service, requests, accounts, pooled };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected the call to fail');
}

describe('BankTransfersService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers the seller’s deposit account, the exact amount and an hour, keeping only a hash and three digits', async () => {
    const { db, service } = setup();
    const before = Date.now();

    const { transfer, created } = await service.open('creq1', '20-12345678-6');

    expect(created).toBe(true);
    expect(transfer).toEqual({
      id: expect.any(String),
      status: 'awaiting_deposit',
      currency: 'ARS',
      amount: '15000',
      alias: 'juan.perez.cp',
      cvu: '0000003100000000000001',
      holder: 'Juan Pérez',
      bank: 'A bank',
      documentHint: '…786',
      expiresAt: expect.any(String),
    });
    const expiresIn = Date.parse(transfer.expiresAt) - before;
    expect(expiresIn).toBeGreaterThan(HOUR - 5_000);
    expect(expiresIn).toBeLessThanOrEqual(HOUR + 5_000);
    const row = db.bankTransfer.rows[0];
    expect(row).toMatchObject({
      paymentRequestId: 'creq1',
      network: 'public',
      providerMerchantId: 'mrc_seller',
      documentHash: documentHash(PEPPER, '12345678'),
      documentHint: '786',
      amount: '15000',
      instructedAmount: '15000',
    });
    expect(JSON.stringify(db.bankTransfer.rows)).not.toContain('12345678');
  });

  it('answers the same transfer for the same person, CUIT or DNI, and a new one for another', async () => {
    const { db, service } = setup();
    const first = await service.open('creq1', '20123456786');

    const again = await service.open('creq1', '12.345.678');
    const other = await service.open('creq1', '87654321');

    expect(again).toEqual({ transfer: first.transfer, created: false });
    expect(other.created).toBe(true);
    expect(other.transfer.id).not.toBe(first.transfer.id);
    expect(db.bankTransfer.rows).toHaveLength(2);
  });

  it('never outlives its request', async () => {
    const soon = new Date(Date.now() + 10 * 60 * 1000);
    const { service } = setup({ requests: [request({ expiresAt: soon })] });

    const { transfer } = await service.open('creq1', '12345678');

    expect(transfer.expiresAt).toBe(soon.toISOString());
  });

  it('gives a stale transfer a new hour when it is asked for again', async () => {
    const { db, service } = setup();
    await service.open('creq1', '12345678');
    db.bankTransfer.rows[0].expiresAt = new Date(Date.now() - 1000);

    const { transfer, created } = await service.open('creq1', '12345678');

    expect(created).toBe(false);
    expect(transfer.status).toBe('awaiting_deposit');
    expect(Date.parse(transfer.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('asks a few cents more when the same buyer already has an open charge of that amount at the seller', async () => {
    const { db, service } = setup();

    const first = await service.open('creq1', '20-12345678-6');
    const second = await service.open('creq2', '12345678');
    const third = await service.open('creq3', '12345678');
    // Another buyer at the same seller asks the plain amount.
    const stranger = await service.open('creq2', '87654321');

    expect(
      [first, second, third, stranger].map((r) => r.transfer.amount),
    ).toEqual(['15000', '15000.01', '15000.02', '15000']);
    // The request's own amount is kept beside what the payer was told.
    expect(db.bankTransfer.rows.map((r) => r.amount)).toEqual([
      '15000',
      '15000',
      '15000',
      '15000',
    ]);
    // Asked again, a transfer keeps its amount.
    await expect(service.open('creq2', '12345678')).resolves.toMatchObject({
      transfer: { amount: '15000.01' },
      created: false,
    });
  });

  it('frees an amount once its transfer is no longer open', async () => {
    const { db, service } = setup();
    await service.open('creq1', '12345678');
    db.bankTransfer.rows[0].status = 'converting';

    const next = await service.open('creq2', '12345678');

    expect(next.transfer.amount).toBe('15000');
  });

  it('sends the seller’s payers to Cosmos Pay’s account in pooled mode when the seller has none', async () => {
    const { db, service, pooled } = setup({
      account: null,
      koywe: {
        pooledEnabled: true,
        environments: {
          ...koyweConfig().koywe.environments,
          public: {
            ...koyweConfig().koywe.environments.public,
            merchantId: 'mrc_pool',
          },
        },
      },
    });

    const { transfer } = await service.open('creq1', '12345678');

    expect(transfer).toMatchObject({
      alias: 'cosmospay.qr',
      cvu: '0000003100000000000000',
      holder: 'Cosmos Pay',
    });
    expect(pooled.instructions).toHaveBeenCalledWith('public', 'mrc_pool');
    expect(db.bankTransfer.rows[0].providerMerchantId).toBe('mrc_pool');
  });

  it('maps every test request to the sandbox, for the pairs the P2P sandbox lists', async () => {
    const { service } = setup({
      requests: [
        request({
          network: 'testnet',
          chainId: 421614,
          tokenAddress: SANDBOX_USDT,
          tokenDecimals: 18,
        }),
      ],
      account: { ...APPROVED, network: 'testnet' },
    });

    await expect(service.open('creq1', '12345678')).resolves.toMatchObject({
      created: true,
    });
  });

  describe('refuses', () => {
    it('an unknown request (404)', async () => {
      const { service } = setup();
      expect(await failure(service.open('cmissing', '12345678'))).toMatchObject(
        { code: ApiErrorCode.NotFound },
      );
    });

    it('a request that is not open (409 request_closed), processing included', async () => {
      for (const status of ['processing', 'paid', 'expired', 'cancelled']) {
        const { service, db } = setup({ requests: [request({ status })] });
        expect(await failure(service.open('creq1', '12345678'))).toMatchObject({
          code: ApiErrorCode.RequestClosed,
          message: `Payment request creq1 is ${status}: it can no longer be paid`,
        });
        expect(db.bankTransfer.rows).toHaveLength(0);
      }
    });

    it('a request a bank transfer cannot pay (400 method_unavailable)', async () => {
      for (const options of [
        { requests: [request({ currency: 'COP' })] },
        { requests: [request({ amount: '999' })] },
        { requests: [request({ chainId: 42161 })] },
        // The seller has no approved account, and pooled mode is off.
        { account: null },
        { account: { ...APPROVED, status: 'in_review' } },
        { account: { ...APPROVED, cvu: null } },
        { koywe: { documentPepper: '' } },
      ]) {
        const { service } = setup(options as never);
        expect(await failure(service.open('creq1', '12345678'))).toMatchObject({
          code: ApiErrorCode.MethodUnavailable,
          message: 'Payment request creq1 cannot be paid by bank transfer',
        });
      }
    });

    it('a document that is neither a CUIT/CUIL nor a DNI (400 invalid_document)', async () => {
      const { service, db } = setup();
      for (const document of ['20-12345678-5', '123', 'abcdefgh', '']) {
        expect(await failure(service.open('creq1', document))).toMatchObject({
          code: ApiErrorCode.InvalidDocument,
        });
      }
      expect(db.bankTransfer.rows).toHaveLength(0);
    });

    it('when the pooled account cannot be read (503 transfer_unavailable), storing nothing', async () => {
      const { service, db, pooled } = setup({
        account: null,
        koywe: {
          pooledEnabled: true,
          environments: {
            ...koyweConfig().koywe.environments,
            public: {
              ...koyweConfig().koywe.environments.public,
              merchantId: 'mrc_pool',
            },
          },
        },
      });
      pooled.instructions.mockRejectedValueOnce(new Error('provider down'));
      expect(await failure(service.open('creq1', '12345678'))).toMatchObject({
        code: ApiErrorCode.TransferUnavailable,
      });
      pooled.instructions.mockResolvedValueOnce(null as never);
      expect(await failure(service.open('creq1', '12345678'))).toMatchObject({
        code: ApiErrorCode.TransferUnavailable,
      });
      expect(db.bankTransfer.rows).toHaveLength(0);
    });
  });
});
