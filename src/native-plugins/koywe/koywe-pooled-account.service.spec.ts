import { Logger } from '@nestjs/common';
import type { AppConfig } from '@/config/configuration';
import { koyweConfig } from '@/native-plugins/koywe/koywe-fakes.fake-spec';
import { KoywePooledAccount } from '@/native-plugins/koywe/koywe-pooled-account.service';
import { KoyweVirtualAccounts } from '@/native-plugins/koywe/koywe-virtual-accounts.service';

function setup(over: Partial<AppConfig['koywe']> = {}, accounts: unknown = []) {
  const client = {
    virtualAccounts: jest.fn(() => Promise.resolve(accounts)),
    createArsVirtualAccount: jest.fn(() =>
      Promise.resolve({
        id: 'va_pool',
        currency: 'ARS',
        virtualBankAccountNumber: '0000003100000000000000',
        alias: 'cosmospay.qr',
      } as Record<string, unknown>),
    ),
  };
  const service = new KoywePooledAccount(
    koyweConfig(over) as never,
    new KoyweVirtualAccounts(client as never),
  );
  return { service, client };
}

describe('KoywePooledAccount', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads the pooled ARS account once in ten minutes, creating it when missing', async () => {
    const { service, client } = setup({ accountHolder: 'Cosmos Pay' });

    const first = await service.instructions('public', 'mrc_pool');
    await service.instructions('public', 'mrc_pool');

    expect(first).toEqual({
      alias: 'cosmospay.qr',
      cvu: '0000003100000000000000',
      holder: 'Cosmos Pay',
      bank: null,
    });
    expect(client.virtualAccounts).toHaveBeenCalledTimes(1);
    expect(client.createArsVirtualAccount).toHaveBeenCalledTimes(1);
  });

  it('lets KOYWE_ALIAS and KOYWE_CVU replace it, with no provider call when both are set', async () => {
    const { service, client } = setup({
      alias: 'override.alias',
      cvu: '0000003100000000000099',
    });

    await expect(service.instructions('public', 'mrc_pool')).resolves.toEqual({
      alias: 'override.alias',
      cvu: '0000003100000000000099',
      holder: null,
      bank: null,
    });
    expect(client.virtualAccounts).not.toHaveBeenCalled();
  });

  it('answers null for an account with no alias', async () => {
    const { service } = setup({}, [
      {
        id: 'va_pool',
        currency: 'ARS',
        isActive: true,
        virtualBankAccountNumber: '0000003100000000000000',
      },
    ]);

    await expect(
      service.instructions('public', 'mrc_pool'),
    ).resolves.toBeNull();
  });
});
