import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { BlindpayClient } from '@/blindpay/blindpay.client';

/** A client whose production instance takes `overrides`; dev is its own pair. */
function makeBlindpay(overrides: Record<string, unknown> = {}) {
  const cfg = {
    baseUrl: 'https://api.blindpay.com/v1',
    timeoutMs: 5000,
    instances: {
      prod: {
        apiKey: 'sk_live',
        instanceId: 'in_123',
        webhookSecret: '',
        ...overrides,
      },
      dev: { apiKey: 'sk_dev', instanceId: 'in_dev', webhookSecret: '' },
    },
  };
  const config = { get: () => cfg } as unknown as ConfigService<any, true>;
  return new BlindpayClient(config);
}

/** The production instance — what every single-instance test below talks to. */
function makeClient(overrides: Record<string, unknown> = {}) {
  return makeBlindpay(overrides).instance('prod');
}

function mockFetch(impl: (url: string, init: any) => Partial<Response>) {
  return (
    jest
      .spyOn(global, 'fetch')
      // `fetch` accepts `string | URL | Request`; the mock has to match that, not
      // the narrower shape these tests happen to pass. `impl` wants a string, so
      // normalise instead of asserting the parameter away.
      .mockImplementation((input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(
          impl(
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
            init,
          ) as Response,
        ),
      )
  );
}

function okJson(body: unknown = {}) {
  return () => ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

afterEach(() => jest.restoreAllMocks());

describe('BlindpayClient', () => {
  it('keeps each environment on its own instance id and key', async () => {
    const spy = mockFetch(okJson());
    const blindpay = makeBlindpay();

    const prod = blindpay.instance('prod');
    const dev = blindpay.instance('dev');
    await prod.get(prod.instancePath('/customers'));
    await dev.get(dev.instancePath('/customers'));

    // A dev key used to reach the production instance: same id, same secret.
    const [prodUrl, prodInit] = spy.mock.calls[0];
    const [devUrl, devInit] = spy.mock.calls[1];
    expect(prodUrl).toBe(
      'https://api.blindpay.com/v1/instances/in_123/customers',
    );
    expect((prodInit as any).headers.authorization).toBe('Bearer sk_live');
    expect(devUrl).toBe(
      'https://api.blindpay.com/v1/instances/in_dev/customers',
    );
    expect((devInit as any).headers.authorization).toBe('Bearer sk_dev');
  });

  it('builds instance-scoped paths', () => {
    expect(makeClient().instancePath('/customers')).toBe(
      '/instances/in_123/customers',
    );
  });

  it('sends the bearer token and parses JSON', async () => {
    const spy = mockFetch(okJson({ id: 're_1' }));

    const client = makeClient();
    const out = await client.get<{ id: string }>(
      client.instancePath('/customers/re_1'),
    );

    expect(out).toEqual({ id: 're_1' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(
      'https://api.blindpay.com/v1/instances/in_123/customers/re_1',
    );
    expect((init as any).headers.authorization).toBe('Bearer sk_live');
  });

  it('serializes the body and appends query params', async () => {
    const spy = mockFetch(() => ({
      ok: true,
      status: 201,
      text: () => Promise.resolve('{}'),
    }));

    const client = makeClient();
    await client.post('/available/bank-details', undefined, {
      query: { rail: 'ach' },
    });
    await client.post(client.instancePath('/customers'), { email: 'a@b.com' });

    expect(spy.mock.calls[0][0]).toBe(
      'https://api.blindpay.com/v1/available/bank-details?rail=ach',
    );
    expect((spy.mock.calls[1][1] as any).body).toBe('{"email":"a@b.com"}');
  });

  it('passes client errors (4xx) through with their status', async () => {
    mockFetch(() => ({
      ok: false,
      status: 422,
      text: () =>
        Promise.resolve(JSON.stringify({ message: 'invalid tax_id' })),
    }));

    const client = makeClient();
    await expect(client.get('/x')).rejects.toMatchObject({
      status: 422,
      code: 'provider_error',
    });
    await expect(client.get('/x')).rejects.toBeInstanceOf(HttpException);
  });

  it('masks the values inside a provider validation message', async () => {
    mockFetch(() => ({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({ message: 'invalid tax_id: 20123456786' }),
        ),
    }));

    const err = await makeClient()
      .get('/x')
      .catch((e: HttpException) => e);
    const body = (err as HttpException).getResponse() as { message: string };
    expect(body.message).toBe('invalid tax_id: [redacted]');
  });

  it('never relays a raw provider body', async () => {
    mockFetch(() => ({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(JSON.stringify({ account_number: '1234567890' })),
    }));

    const err = await makeClient()
      .get('/x')
      .catch((e: HttpException) => e);
    const body = (err as HttpException).getResponse() as { message: string };
    expect(body.message).toBe('The payment provider rejected the request.');
  });

  it('collapses upstream 5xx into a 502 that echoes nothing', async () => {
    mockFetch(() => ({
      ok: false,
      status: 503,
      text: () => Promise.resolve('upstream down: db 10.0.0.4 unreachable'),
    }));

    const err = await makeClient()
      .get('/x')
      .catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(502);
    const body = (err as HttpException).getResponse() as { message: string };
    expect(body.message).not.toContain('10.0.0.4');
  });

  it('maps an aborted request to a 504', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const err = await makeClient()
      .get('/x')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    // 504 is the honest status, and it now carries a code — 504 had no
    // CODE_BY_STATUS entry, so an upstream timeout reported `internal_error`
    // and read to an integrator as a bug in this service.
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(err!.code).toBe(ApiErrorCode.ProviderUnavailable);
  });

  it('answers 503 misconfigured when not configured', async () => {
    const err = await makeClient({ apiKey: '' })
      .get('/x')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    // A bare 503 defaulted to `provider_unavailable`, which tells a caller to
    // retry an upstream that is fine. It is this deployment that needs fixing.
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err!.code).toBe(ApiErrorCode.Misconfigured);
  });

  it('names the missing variables of the environment that is not set up', async () => {
    const spy = mockFetch(okJson());
    const blindpay = new BlindpayClient({
      get: () => ({
        baseUrl: 'https://api.blindpay.com/v1',
        timeoutMs: 5000,
        instances: {
          prod: { apiKey: 'sk_live', instanceId: 'in_123', webhookSecret: '' },
          dev: { apiKey: '', instanceId: '', webhookSecret: '' },
        },
      }),
    } as unknown as ConfigService<any, true>);

    const err = await blindpay
      .instance('dev')
      .get('/x')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    // A dev key with no dev instance is refused — never quietly served by prod.
    expect(err!.code).toBe(ApiErrorCode.Misconfigured);
    expect(err!.message).toContain('BLINDPAY_API_KEY_DEV');
    expect(spy).not.toHaveBeenCalled();
  });
});
