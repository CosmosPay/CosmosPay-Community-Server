import type { AppConfig } from '@/config/configuration';
import { BankTransferRail } from '@/native-plugins/koywe/bank-transfer-rail.service';
import {
  koyweConfig,
  POLYGON_USDT,
} from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';

const TERMS = {
  ownerId: 'c_seller',
  network: 'public' as const,
  currency: 'ARS',
  amount: '15000',
  chainId: 137,
  tokenAddress: POLYGON_USDT,
};

const ACCOUNT: {
  name: string;
  status: string;
  providerMerchantId: string | null;
  alias: string | null;
  cvu: string | null;
  bank: string | null;
} = {
  name: 'Juan Pérez',
  status: 'approved',
  providerMerchantId: 'mrc_seller',
  alias: 'juan.perez.cp',
  cvu: '0000003100000000000001',
  bank: null,
};

function setup(
  account: Partial<typeof ACCOUNT> | null = ACCOUNT,
  koywe: Partial<AppConfig['koywe']> = {},
) {
  const config = koyweConfig(koywe);
  const accounts = {
    forOwner: jest.fn(() =>
      Promise.resolve(account ? { ...ACCOUNT, ...account } : null),
    ),
  };
  const rails = new PaymentRequestRails();
  const rail = new BankTransferRail(config as never, rails, accounts as never);
  rail.onModuleInit();
  return { rail, rails, accounts };
}

const pooled = (merchantId = 'mrc_pool'): Partial<AppConfig['koywe']> => {
  const environments = koyweConfig().koywe.environments;
  return {
    pooledEnabled: true,
    environments: {
      ...environments,
      public: { ...environments.public, merchantId },
    },
  };
};

describe('BankTransferRail', () => {
  it('registers as the transfer rail and pays a seller with an approved account', async () => {
    const { rails, accounts } = setup();

    await expect(rails.methodsFor(TERMS, null, true)).resolves.toEqual([
      'transfer',
      'p2p',
    ]);
    expect(accounts.forOwner).toHaveBeenCalledWith('c_seller', 'public');
  });

  it('pays no seller whose account is missing, not approved or without its CVU, unless pooled', async () => {
    for (const account of [
      null,
      { status: 'pending' },
      { status: 'in_review' },
      { status: 'rejected' },
      { cvu: null },
      { alias: null },
    ]) {
      await expect(
        setup(account).rail.accepts(TERMS, null),
      ).resolves.toBeNull();
      await expect(
        setup(account, pooled()).rail.accepts(TERMS, null),
      ).resolves.toEqual({ symbol: 'USDT', decimals: 6 });
    }
    // Pooled mode needs Cosmos Pay's merchant on that network.
    await expect(
      setup(null, { pooledEnabled: true }).rail.accepts(TERMS, null),
    ).resolves.toBeNull();
  });

  it('answers whose merchant the payers transfer to', async () => {
    await expect(setup().rail.payee('c_seller', 'public')).resolves.toEqual({
      merchantId: 'mrc_seller',
      pooled: false,
      account: {
        holder: 'Juan Pérez',
        alias: 'juan.perez.cp',
        cvu: '0000003100000000000001',
        bank: null,
      },
    });
    await expect(
      setup(null, pooled()).rail.payee('c_public', 'public'),
    ).resolves.toEqual({ merchantId: 'mrc_pool', pooled: true, account: null });
  });

  it('asks for an owner’s account once for a page of requests, and afresh when told to', async () => {
    const { rail, accounts } = setup();

    await Promise.all([
      rail.accepts(TERMS, null),
      rail.accepts({ ...TERMS, amount: '20000' }, null),
      rail.accepts(TERMS, null),
    ]);
    expect(accounts.forOwner).toHaveBeenCalledTimes(1);

    await rail.payee('c_seller', 'public', true);
    expect(accounts.forOwner).toHaveBeenCalledTimes(2);
  });

  it('never asks for the account of terms the rail cannot pay anyway', async () => {
    const { rail, accounts } = setup();

    await expect(
      rail.accepts({ ...TERMS, currency: 'BRL' }, null),
    ).resolves.toBeNull();
    expect(accounts.forOwner).not.toHaveBeenCalled();
  });
});
