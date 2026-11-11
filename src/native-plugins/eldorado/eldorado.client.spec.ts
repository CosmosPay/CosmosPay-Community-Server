import { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';

function client(cfg: {
  clientId: string;
  referralId: string;
  publicReferralId: string;
}): EldoradoClient {
  const config = { get: jest.fn(() => ({ ...cfg, timeoutMs: 1000 })) };
  return new EldoradoClient(config as never);
}

describe('EldoradoClient.integratorIds', () => {
  it('gives the shared public key its own referral id when one is set', () => {
    const c = client({
      clientId: 'c-1',
      referralId: 'r-accounts',
      publicReferralId: 'r-public',
    });

    expect(c.integratorIds(true)).toEqual({
      clientId: 'c-1',
      referralId: 'r-public',
    });
    expect(c.integratorIds(false)).toEqual({
      clientId: 'c-1',
      referralId: 'r-accounts',
    });
  });

  it('falls back to the ordinary referral id when no public one is set', () => {
    const c = client({
      clientId: 'c-1',
      referralId: 'r-accounts',
      publicReferralId: '',
    });

    expect(c.integratorIds(true)).toEqual({
      clientId: 'c-1',
      referralId: 'r-accounts',
    });
  });

  it('has no ids without a client id, whatever the referral ids', () => {
    const c = client({
      clientId: '',
      referralId: 'r-accounts',
      publicReferralId: 'r-public',
    });

    expect(c.integratorIds(true)).toBeNull();
    expect(c.integratorIds(false)).toBeNull();
  });

  it('refuses a firm quote without ids before any call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const c = client({ clientId: '', referralId: '', publicReferralId: '' });

    await expect(
      Promise.resolve().then(() =>
        c.buyQuote(
          'public',
          {
            token: '0x0',
            chainId: '42161',
            fiatCurrencyId: 'ARS',
            paymentMethodId: 'bank_tx_ar',
            amount: '1',
            fixedAmountSide: 'IN',
            addressTo: '0x0',
          },
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: 'misconfigured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
