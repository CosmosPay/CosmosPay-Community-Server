import { Logger } from '@nestjs/common';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { KoyweEnvironmentConfig } from '@/config/configuration';
import { KoyweClient, redactDigits } from '@/native-plugins/koywe/koywe.client';

const SANDBOX: KoyweEnvironmentConfig = {
  apiUrl: 'https://api-sandbox.koywe.example',
  apiKey: 'the-key',
  secret: 'the-secret',
  organizationId: 'org_1',
  merchantId: '',
  webhookSecret: 'w'.repeat(40),
};

/** The error a call fails with. */
async function failure(
  promise: Promise<unknown>,
): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string; code?: string };
  }
  throw new Error('expected the call to fail');
}

function setup(environment: Partial<KoyweEnvironmentConfig> = {}) {
  const config = {
    get: jest.fn(() => ({
      environments: {
        public: { ...SANDBOX, apiKey: '' },
        testnet: { ...SANDBOX, ...environment },
      },
    })),
  };
  const client = new KoyweClient(config as never);
  const calls: {
    url: string;
    method: string;
    auth?: string;
    body?: unknown;
  }[] = [];
  const answers: Response[] = [];
  const fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockImplementation((input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        method: init?.method ?? 'GET',
        auth: headers.authorization,
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = answers.shift();
      return Promise.resolve(
        next ?? new Response(JSON.stringify({}), { status: 200 }),
      );
    });
  const reply = (status: number, body: unknown) =>
    answers.push(new Response(JSON.stringify(body), { status }));
  return { client, calls, reply, fetchSpy };
}

describe('KoyweClient', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('signs in once and reuses the token for the merchant-scoped calls', async () => {
    const { client, calls, reply } = setup();
    reply(200, { token: 'tok-1' });
    reply(200, { id: 'q_1' });
    reply(200, { id: 'ord_1' });

    await client.quote('testnet', 'mrc_seller', {
      orderType: 'ONRAMP',
      executable: true,
      originCurrencySymbol: 'ARS',
      destinationCurrencySymbol: 'USDT',
      amountIn: 15000,
      network: 'POLYGON',
    });
    await client.order('testnet', 'mrc_seller', 'ord_1');

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://api-sandbox.koywe.example/api/v1/auth/sign-in'],
      [
        'POST',
        'https://api-sandbox.koywe.example/api/v1/organizations/org_1/merchants/mrc_seller/quotes',
      ],
      [
        'GET',
        'https://api-sandbox.koywe.example/api/v1/organizations/org_1/merchants/mrc_seller/orders/ord_1',
      ],
    ]);
    expect(calls[0].body).toEqual({ apiKey: 'the-key', secret: 'the-secret' });
    expect(calls[1].auth).toBe('Bearer tok-1');
    expect(calls[2].auth).toBe('Bearer tok-1');
  });

  it('signs in again once on a 401, and retries the call', async () => {
    const { client, calls, reply } = setup();
    reply(200, { token: 'tok-1' });
    reply(401, { message: 'jwt expired' });
    reply(200, { token: 'tok-2' });
    reply(200, [{ id: 'va_1' }]);

    await expect(client.virtualAccounts('testnet', 'mrc_1')).resolves.toEqual([
      { id: 'va_1' },
    ]);
    expect(calls.map((c) => c.auth)).toEqual([
      undefined,
      'Bearer tok-1',
      undefined,
      'Bearer tok-2',
    ]);
  });

  it('gives up on a second 401: the credentials are wrong', async () => {
    const { client, reply } = setup();
    reply(200, { token: 'tok-1' });
    reply(401, {});
    reply(200, { token: 'tok-2' });
    reply(401, {});

    await expect(
      client.virtualAccounts('testnet', 'mrc_1'),
    ).rejects.toMatchObject({
      code: ApiErrorCode.Misconfigured,
    });
  });

  it('refuses a refused sign-in as misconfigured, naming no provider to the caller', async () => {
    const { client, reply } = setup();
    reply(401, { message: 'Invalid credentials' });

    const error = await failure(client.virtualAccounts('testnet', 'mrc_1'));
    expect(error).toMatchObject({ code: ApiErrorCode.Misconfigured });
    expect(error.message).not.toMatch(/koywe/i);
  });

  it('makes no call for an incomplete environment', async () => {
    const { client, calls } = setup({ webhookSecret: '' });

    expect(client.isConfigured('testnet')).toBe(false);
    expect(client.isConfigured('public')).toBe(false);
    await expect(
      client.order('testnet', 'mrc_1', 'ord_1'),
    ).rejects.toMatchObject({ code: ApiErrorCode.Misconfigured });
    expect(calls).toHaveLength(0);
  });

  it('answers null for an order no external id names', async () => {
    const { client, calls, reply } = setup();
    reply(200, { token: 'tok-1' });
    reply(404, { message: 'Order not found' });

    await expect(
      client.orderByExternalId('testnet', 'mrc_1', 'btr 1/2'),
    ).resolves.toBeNull();
    expect(calls[1].url).toBe(
      'https://api-sandbox.koywe.example/api/v1/organizations/org_1/merchants/mrc_1/orders/external/btr%201%2F2',
    );
  });

  it('registers a webhook endpoint with the environment’s own secret', async () => {
    const { client, calls, reply } = setup();
    reply(200, { token: 'tok-1' });
    reply(201, { id: 'wh_1' });

    await client.createWebhookEndpoint(
      'testnet',
      'https://api.example/cosmos-api/v1/onramp/transfer/webhooks',
      'Cosmos Pay',
    );

    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://api-sandbox.koywe.example/api/v1/organizations/org_1/webhooks',
      body: {
        url: 'https://api.example/cosmos-api/v1/onramp/transfer/webhooks',
        name: 'Cosmos Pay',
        secret: 'w'.repeat(40),
      },
    });
  });

  it('never logs or relays a tax id the provider echoes in an error', async () => {
    const { client, reply } = setup();
    reply(200, { token: 'tok-1' });
    reply(422, { message: 'taxIdNumber 20-12345678-6 is already registered' });

    const error = await failure(
      client.createMerchant('testnet', {
        countryId: 'ctry_ar',
        profile: {
          name: 'Juan',
          address: 'Street 1',
          taxIdType: 'CUIL',
          taxIdNumber: '20123456786',
          slug: 'cosmospay-acct1',
          supportEmail: 'juan@example.com',
          email: 'juan@example.com',
        },
      }),
    );

    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('12345678');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('12345678');
  });

  it('masks runs of seven or more digits, and leaves short numbers alone', () => {
    expect(redactDigits('document 12.345.678 refused')).toBe(
      'document [redacted] refused',
    );
    expect(redactDigits('CVU 0000003100000000000001')).toBe('CVU [redacted]');
    expect(redactDigits('amount 15000 below 20000')).toBe(
      'amount 15000 below 20000',
    );
  });
});
