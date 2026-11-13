import { UpstreamStatusError } from '@/common/upstream-http';
import { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';

function client(cfg: {
  clientId: string;
  referralId: string;
  publicReferralId: string;
  apiReferralId?: string;
}): EldoradoClient {
  const config = {
    get: jest.fn(() => ({ apiReferralId: '', ...cfg, timeoutMs: 1000 })),
  };
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

describe('EldoradoClient, the direct flow', () => {
  let fetchSpy: jest.SpyInstance;
  const direct = () =>
    client({
      clientId: 'c-1',
      referralId: 'r-widget',
      publicReferralId: 'r-public',
      apiReferralId: 'r-api',
    });

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }))),
      );
  });

  afterEach(() => fetchSpy.mockRestore());

  const call = (at = 0) => {
    const [url, init] = fetchSpy.mock.calls[at] as [string, RequestInit];
    return {
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    };
  };

  it('signs in with the API referral id and no bearer token', async () => {
    await direct().sendLoginCode('testnet', 'payer@example.com', 'es');
    const sent = call();
    expect(sent.url).toBe(
      'https://api-testnet.eldorado.io/api/auth/login/send-otp',
    );
    expect(sent.method).toBe('POST');
    expect(sent.headers).toMatchObject({
      'X-Client-ID': 'c-1',
      'X-Referral-ID': 'r-api',
    });
    expect(sent.headers.Authorization).toBeUndefined();
    expect(sent.body).toEqual({ email: 'payer@example.com', language: 'es' });
  });

  it('sends the payer’s bearer token on every authenticated call', async () => {
    const c = direct();
    await c.kyc('public', 'jwt-1');
    await c.submitKycDetails('public', 'jwt-1', {
      countryOfResidence: 'AR',
      cityOfResidence: 'Salta',
      phoneNumber: '+543874123456',
    });
    await c.verifyKycPhone('public', 'jwt-1', '1234');
    await c.userInfo('public', 'jwt-1');
    await c.paymentDetails('public', 'jwt-1');
    await c.order('public', 'jwt-1', 'ord-1');
    await c.markOrderPaid('public', 'jwt-1', 'ord-1');
    await c.cancelOrder('public', 'jwt-1', 'ord-1');

    const sent = fetchSpy.mock.calls.map((_, at) => call(at));
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://api.eldorado.io/api/kyc',
      'POST https://api.eldorado.io/api/kyc',
      'POST https://api.eldorado.io/api/kyc/phone',
      'GET https://api.eldorado.io/api/user-info',
      'GET https://api.eldorado.io/api/payment-details?paymentMethodId=bank_tx_ar',
      'GET https://api.eldorado.io/api/orders/ord-1',
      'POST https://api.eldorado.io/api/orders/ord-1',
      'POST https://api.eldorado.io/api/orders/ord-1/cancel',
    ]);
    for (const s of sent) {
      expect(s.headers).toMatchObject({
        Authorization: 'Bearer jwt-1',
        'X-Client-ID': 'c-1',
        'X-Referral-ID': 'r-api',
      });
    }
    expect(sent[1].body).toEqual({
      data: {
        level: 'L1',
        values: {
          countryOfResidence: 'AR',
          cityOfResidence: 'Salta',
          phoneNumber: '+543874123456',
        },
      },
    });
    expect(sent[2].body).toEqual({ code: '1234' });
    // Marking paid takes no body.
    expect(sent[6].body).toBeUndefined();
  });

  it('escapes an order id in the path', async () => {
    await direct().order('public', 'jwt-1', '../user-info');
    expect(call().url).toBe(
      'https://api.eldorado.io/api/orders/..%2Fuser-info',
    );
  });

  it('is 503 p2p_unavailable without the API referral id, before any call', async () => {
    const c = client({
      clientId: 'c-1',
      referralId: 'r-widget',
      publicReferralId: '',
    });
    expect(c.directIds()).toBeNull();
    expect(() => c.kyc('public', 'jwt-1')).toThrow(
      expect.objectContaining({ code: 'p2p_unavailable' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hands a refusal back as an UpstreamStatusError', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ errorCode: 'TOO_MANY_ACTIVE_ORDERS', message: 'x' }),
        { status: 429 },
      ),
    );
    const error = await direct()
      .createBuyOrder('public', 'jwt-1', {
        quoteId: 'q-1',
        fiatDetails: { detailsId: 'd-1' },
        cryptoDetails: {
          recipientAddress: '0x52908400098527886E0F7030069857D2E4169EE7',
          tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
          chainId: '42161',
        },
        externalReferenceId: 'cmh4x2k9a0001l70g8v5q3z2w',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamStatusError);
    expect(error).toMatchObject({
      status: 429,
      code: 'TOO_MANY_ACTIVE_ORDERS',
    });
  });
});
