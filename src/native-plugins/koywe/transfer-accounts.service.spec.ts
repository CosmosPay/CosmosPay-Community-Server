import { Logger } from '@nestjs/common';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PublicRecordTokens } from '@/common/public-record-token';
import { koyweConfig } from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import { koyweDb } from '@/native-plugins/koywe/koywe-memory-db.fake-spec';
import { KoyweVirtualAccounts } from '@/native-plugins/koywe/koywe-virtual-accounts.service';
import {
  TransferAccountsService,
  type TransferAccountInput,
} from '@/native-plugins/koywe/transfer-accounts.service';

const key = (
  username: string,
  environment: 'prod' | 'dev' = 'prod',
  role: GatewayConsumer['role'] = 'user',
): GatewayConsumer => ({
  username,
  credentialId: null,
  environment,
  role,
  permissions: ['onramp:read', 'onramp:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
});
const seller = key('cosmos_seller');
const publicKey = key('cosmos_public', 'prod', 'public');

const PERSON: TransferAccountInput = {
  type: 'person',
  name: 'Juan Pérez',
  taxId: '20-12345678-6',
  email: 'juan@example.com',
  phone: '+5493875551234',
  address: 'Av. Belgrano 123',
  city: 'Salta',
  postalCode: '4400',
  dateOfBirth: '1990-01-15',
};

function setup() {
  const db = koyweDb();
  const config = koyweConfig();
  const consumers = {
    resolve: jest.fn((c: GatewayConsumer) =>
      Promise.resolve({ id: `c_${c.username}` }),
    ),
    resolveId: jest.fn((c: GatewayConsumer) =>
      Promise.resolve(`c_${c.username}`),
    ),
  };
  const client = {
    isConfigured: jest.fn(() => true),
    countries: jest.fn(() =>
      Promise.resolve([
        { id: 'ctry_cl', twoLetterIso: 'CL' },
        { id: 'ctry_ar', twoLetterIso: 'AR' },
      ]),
    ),
    createMerchant: jest.fn(() =>
      Promise.resolve({ merchantId: 'mrc_seller', slug: 'x' } as Record<
        string,
        unknown
      >),
    ),
    triggerKyb: jest.fn(() =>
      Promise.resolve({
        id: 'kyb_1',
        status: 'CREATED',
        formLink: null,
      } as Record<string, unknown>),
    ),
    kyb: jest.fn(() =>
      Promise.resolve({
        id: 'kyb_1',
        status: 'PENDING',
        formLink: 'https://verify.example/form/1',
      } as Record<string, unknown>),
    ),
    virtualAccounts: jest.fn(() => Promise.resolve([] as unknown)),
    createArsVirtualAccount: jest.fn(() =>
      Promise.resolve({
        id: 'va_1',
        currency: 'ARS',
        isActive: true,
        virtualBankAccountNumber: '0000003100000000000001',
        alias: 'juan.perez.cp',
      } as Record<string, unknown>),
    ),
  };
  const service = new TransferAccountsService(
    config as never,
    db as never,
    consumers as never,
    new PublicRecordTokens(config as never),
    client as never,
    new KoyweVirtualAccounts(client as never),
  );
  return { db, client, service };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected the call to fail');
}

describe('TransferAccountsService', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('opens a merchant in the seller’s name and its KYB, keeping only ids, the name, the type and three digits', async () => {
    const { db, client, service } = setup();

    const view = await service.open(seller, PERSON);

    expect(client.createMerchant).toHaveBeenCalledWith('public', {
      countryId: 'ctry_ar',
      profile: {
        name: 'Juan Pérez',
        address: 'Av. Belgrano 123',
        city: 'Salta',
        postalCode: '4400',
        taxIdType: 'CUIL',
        taxIdNumber: '20123456786',
        slug: `cosmospay-${String(db.bankTransferAccount.rows[0].id)}`,
        supportEmail: 'juan@example.com',
        email: 'juan@example.com',
        phone: '+5493875551234',
        dateOfBirth: '1990-01-15',
        nationalityCountrySymbol: 'AR',
      },
    });
    expect(client.triggerKyb).toHaveBeenCalledWith('public', 'mrc_seller', {
      contactOverride: { email: 'juan@example.com', language: 'es' },
    });
    expect(view).toMatchObject({
      status: 'pending',
      type: 'person',
      name: 'Juan Pérez',
      cvu: null,
    });
    const row = db.bankTransferAccount.rows[0];
    expect(row).toMatchObject({
      consumerId: 'c_cosmos_seller',
      network: 'public',
      type: 'person',
      name: 'Juan Pérez',
      taxIdHint: '786',
      providerMerchantId: 'mrc_seller',
      kybId: 'kyb_1',
      status: 'pending',
    });
    const stored = JSON.stringify(db.bankTransferAccount.rows);
    for (const secret of [
      '12345678',
      'juan@example.com',
      'Belgrano',
      '1990-01-15',
      '5493875551234',
    ]) {
      expect(stored).not.toContain(secret);
    }
    const logged = logs
      .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
      .join('\n');
    expect(logged).not.toContain('12345678');
  });

  it('opens a company with its CUIT and no date of birth', async () => {
    const { client, service } = setup();

    await service.open(seller, {
      ...PERSON,
      type: 'company',
      name: 'Acme SA',
      taxId: '30-71234567-1',
      dateOfBirth: undefined,
    });

    expect(client.createMerchant).toHaveBeenCalledWith(
      'public',
      expect.objectContaining({
        profile: expect.not.objectContaining({
          dateOfBirth: expect.anything(),
        }),
      }),
    );
    expect((client.createMerchant.mock.calls[0] as unknown[])[1]).toMatchObject(
      { profile: { taxIdType: 'CUIT', taxIdNumber: '30712345671' } },
    );
  });

  it('refuses the shared public key with 403 account_required, reading and opening alike', async () => {
    const { service, db } = setup();

    for (const call of [
      service.view(publicKey),
      service.open(publicKey, PERSON),
    ]) {
      expect(await failure(call)).toMatchObject({
        code: ApiErrorCode.AccountRequired,
      });
    }
    expect(db.bankTransferAccount.rows).toHaveLength(0);
  });

  it('refuses a tax id the type cannot have (400 invalid_tax_id), before calling anyone', async () => {
    const { service, client } = setup();

    for (const input of [
      { ...PERSON, taxId: '20-12345678-5' },
      { ...PERSON, type: 'company' as const },
      { ...PERSON, taxId: '30-71234567-1' },
    ]) {
      expect(await failure(service.open(seller, input))).toMatchObject({
        code: ApiErrorCode.InvalidTaxId,
      });
    }
    expect(client.createMerchant).not.toHaveBeenCalled();
  });

  it('answers 409 account_exists while an account is not rejected, and submits a rejected one again', async () => {
    const { db, client, service } = setup();
    await service.open(seller, PERSON);

    expect(await failure(service.open(seller, PERSON))).toMatchObject({
      code: ApiErrorCode.AccountExists,
      message: expect.stringContaining('(pending)'),
    });

    db.bankTransferAccount.rows[0].status = 'rejected';
    db.bankTransferAccount.rows[0].reason = 'document unreadable';
    const again = await service.open(seller, PERSON);

    expect(client.createMerchant).toHaveBeenCalledTimes(1);
    expect(client.triggerKyb).toHaveBeenLastCalledWith('public', 'mrc_seller', {
      forceRetrigger: true,
      contactOverride: { email: 'juan@example.com', language: 'es' },
    });
    expect(again).toMatchObject({ status: 'pending', reason: null });
  });

  it('keeps one account per network: a sandbox key opens its own', async () => {
    const { db, service } = setup();
    await service.open(seller, PERSON);

    await service.open(key('cosmos_seller', 'dev'), PERSON);

    expect(db.bankTransferAccount.rows.map((r) => r.network)).toEqual([
      'public',
      'testnet',
    ]);
    await expect(
      service.view(key('cosmos_seller', 'dev')),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(service.view(key('cosmos_mallory'))).resolves.toMatchObject({
      status: 'none',
    });
  });

  it('removes the row and answers 503 when the merchant cannot be opened, so the seller can retry', async () => {
    const { db, client, service } = setup();
    client.createMerchant.mockRejectedValueOnce(new Error('provider down'));

    expect(await failure(service.open(seller, PERSON))).toMatchObject({
      code: ApiErrorCode.TransferUnavailable,
    });
    expect(db.bankTransferAccount.rows).toHaveLength(0);
    await expect(service.open(seller, PERSON)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('answers 503 on a network the deployment does not serve', async () => {
    const { client, service } = setup();
    client.isConfigured.mockReturnValue(false);

    expect(await failure(service.open(seller, PERSON))).toMatchObject({
      code: ApiErrorCode.TransferUnavailable,
    });
    expect(client.createMerchant).not.toHaveBeenCalled();
  });

  it('keeps a merchant whose KYB could not be submitted pending, for the sweep', async () => {
    const { db, client, service } = setup();
    client.triggerKyb.mockRejectedValueOnce(new Error('provider down'));

    await expect(service.open(seller, PERSON)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(db.bankTransferAccount.rows[0]).toMatchObject({
      providerMerchantId: 'mrc_seller',
      kybId: null,
    });

    await service.refresh(db.bankTransferAccount.rows[0] as never);
    expect(db.bankTransferAccount.rows[0].kybId).toBe('kyb_1');
  });

  it('asks for the missing verification link on a read, at most every 30 seconds', async () => {
    const { db, client, service } = setup();
    await service.open(seller, PERSON);
    db.bankTransferAccount.rows[0].kybCheckedAt = new Date(Date.now() - 31_000);

    await expect(service.view(seller)).resolves.toMatchObject({
      status: 'pending',
      verificationUrl: 'https://verify.example/form/1',
    });
    db.bankTransferAccount.rows[0].verificationUrl = null;
    await service.view(seller);

    expect(client.kyb).toHaveBeenCalledTimes(1);
  });

  describe('KYB outcomes', () => {
    it('approves the account and opens its ARS account, which payers are then sent to', async () => {
      const { db, client, service } = setup();
      await service.open(seller, PERSON);

      await service.applyKyb('public', 'mrc_seller', 'approved', {});

      expect(client.createArsVirtualAccount).toHaveBeenCalledWith(
        'public',
        'mrc_seller',
      );
      expect(db.bankTransferAccount.rows[0]).toMatchObject({
        status: 'approved',
        alias: 'juan.perez.cp',
        cvu: '0000003100000000000001',
        virtualAccountId: 'va_1',
        verificationUrl: null,
      });
      await expect(service.view(seller)).resolves.toMatchObject({
        status: 'approved',
        alias: 'juan.perez.cp',
        cvu: '0000003100000000000001',
      });
    });

    it('reuses an ARS account the merchant already has', async () => {
      const { db, client, service } = setup();
      await service.open(seller, PERSON);
      client.virtualAccounts.mockResolvedValueOnce([
        { id: 'va_usd', currency: 'USD', isActive: true },
        {
          id: 'va_ars',
          currency: 'ARS',
          isActive: true,
          virtualBankAccountNumber: '0000003100000000000009',
          alias: 'existing.alias',
          bankName: 'A bank',
        },
      ]);

      await service.applyKyb('public', 'mrc_seller', 'approved');

      expect(client.createArsVirtualAccount).not.toHaveBeenCalled();
      expect(db.bankTransferAccount.rows[0]).toMatchObject({
        cvu: '0000003100000000000009',
        bank: 'A bank',
      });
    });

    it('keeps an approved account approved without its CVU when the provider fails, for the sweep', async () => {
      const { db, client, service } = setup();
      await service.open(seller, PERSON);
      client.createArsVirtualAccount.mockRejectedValueOnce(new Error('held'));
      client.virtualAccounts.mockResolvedValue([]);

      await service.applyKyb('public', 'mrc_seller', 'approved');
      expect(db.bankTransferAccount.rows[0]).toMatchObject({
        status: 'approved',
        cvu: null,
      });

      await service.refresh(db.bankTransferAccount.rows[0] as never);
      expect(db.bankTransferAccount.rows[0].cvu).toBe('0000003100000000000001');
    });

    it('rejects with the reason, and never moves an approved account back', async () => {
      const { db, service } = setup();
      await service.open(seller, PERSON);

      await service.applyKyb('public', 'mrc_seller', 'rejected', {
        reason: 'document\nunreadable',
      });
      await expect(service.view(seller)).resolves.toMatchObject({
        status: 'rejected',
        reason: 'document unreadable',
      });

      await service.applyKyb('public', 'mrc_seller', 'approved');
      await service.applyKyb('public', 'mrc_seller', 'in_review');
      expect(db.bankTransferAccount.rows[0].status).toBe('approved');
    });

    it('ignores another network’s or an unknown merchant’s outcome', async () => {
      const { db, service } = setup();
      await service.open(seller, PERSON);

      await service.applyKyb('testnet', 'mrc_seller', 'approved');
      await service.applyKyb('public', 'mrc_stranger', 'approved');

      expect(db.bankTransferAccount.rows[0].status).toBe('pending');
    });

    it('reads a KYB back for the sweep', async () => {
      const { db, client, service } = setup();
      await service.open(seller, PERSON);
      client.kyb.mockResolvedValueOnce({
        id: 'kyb_1',
        status: 'MANUAL_REVIEW',
      });

      await service.refresh(db.bankTransferAccount.rows[0] as never);

      expect(db.bankTransferAccount.rows[0].status).toBe('in_review');
    });
  });
});
