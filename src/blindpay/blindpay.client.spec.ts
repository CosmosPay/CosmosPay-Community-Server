import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BlindpayClient } from './blindpay.client';

function makeClient(overrides: Record<string, unknown> = {}) {
  const cfg = {
    apiKey: 'sk_test',
    instanceId: 'in_123',
    baseUrl: 'https://api.blindpay.com/v1',
    webhookSecret: '',
    timeoutMs: 5000,
    ...overrides,
  };
  const config = { get: () => cfg } as unknown as ConfigService<any, true>;
  return new BlindpayClient(config);
}

function mockFetch(impl: (url: string, init: any) => Partial<Response>) {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation((url: string, init: any) =>
      Promise.resolve(impl(url, init) as Response),
    );
}

afterEach(() => jest.restoreAllMocks());

describe('BlindpayClient', () => {
  it('builds instance-scoped paths', () => {
    expect(makeClient().instancePath('/customers')).toBe(
      '/instances/in_123/customers',
    );
  });

  it('sends the bearer token and parses JSON', async () => {
    const spy = mockFetch(() => ({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ id: 're_1' })),
    }));

    const client = makeClient();
    const out = await client.get<{ id: string }>(
      client.instancePath('/customers/re_1'),
    );

    expect(out).toEqual({ id: 're_1' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(
      'https://api.blindpay.com/v1/instances/in_123/customers/re_1',
    );
    expect((init as any).headers.authorization).toBe('Bearer sk_test');
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
    });
    await expect(client.get('/x')).rejects.toBeInstanceOf(HttpException);
  });

  it('collapses upstream 5xx into a 502', async () => {
    mockFetch(() => ({
      ok: false,
      status: 503,
      text: () => Promise.resolve('upstream down'),
    }));

    await expect(makeClient().get('/x')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps an aborted request to a 504', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(makeClient().get('/x')).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('throws 503 when not configured', async () => {
    await expect(makeClient({ apiKey: '' }).get('/x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
