import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { NearIntentsClient } from '@/near-intents/near-intents.client';

function makeClient(overrides: Record<string, unknown> = {}) {
  const cfg = {
    baseUrl: 'https://1click.example',
    apiKey: 'partner-key',
    feeRecipient: 'cosmospay.near',
    timeoutMs: 5000,
    ...overrides,
  };
  const config = { get: () => cfg } as unknown as ConfigService<any, true>;
  return new NearIntentsClient(config);
}

function mockFetch(
  impl: (url: string, init: RequestInit | undefined) => Partial<Response>,
) {
  return jest
    .spyOn(global, 'fetch')
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
    );
}

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => jest.restoreAllMocks());

describe('NearIntentsClient', () => {
  it('sends the partner key as X-API-Key, and none when unset', async () => {
    const fetch = mockFetch(() => answer(200, []));
    await makeClient().tokens();
    await makeClient({ apiKey: '' }).tokens();

    const headers = fetch.mock.calls.map(
      ([, init]) => init?.headers as Record<string, string>,
    );
    expect(headers[0]['x-api-key']).toBe('partner-key');
    expect(headers[1]).not.toHaveProperty('x-api-key');
  });

  it('caches the token list, but not a failed fetch', async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return calls === 1 ? answer(502, {}) : answer(200, [{ symbol: 'XLM' }]);
    });
    const client = makeClient();

    await expect(client.tokens()).rejects.toBeInstanceOf(ApiError);
    await expect(client.tokens()).resolves.toEqual([{ symbol: 'XLM' }]);
    await client.tokens();
    expect(calls).toBe(2);
  });

  it('serves a list past its ttl at once and refreshes it once in the background', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T12:00:00Z') });
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return answer(200, [{ symbol: calls === 1 ? 'OLD' : 'NEW' }]);
    });
    const client = makeClient();
    await client.tokens();

    // Six minutes on: past the five-minute ttl, inside the hour it may still be served.
    jest.setSystemTime(new Date('2026-10-26T12:06:00Z'));
    const [a, b] = await Promise.all([client.tokens(), client.tokens()]);
    expect(a).toEqual([{ symbol: 'OLD' }]);
    expect(b).toEqual([{ symbol: 'OLD' }]);
    // One refresh for both callers, and the next caller reads its answer.
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    await expect(client.tokens()).resolves.toEqual([{ symbol: 'NEW' }]);
    expect(calls).toBe(2);
    jest.useRealTimers();
  });

  it('keeps the list it has when a background refresh fails', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T12:00:00Z') });
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return calls === 1 ? answer(200, [{ symbol: 'XLM' }]) : answer(502, {});
    });
    const client = makeClient();
    await client.tokens();

    jest.setSystemTime(new Date('2026-10-26T12:10:00Z'));
    await expect(client.tokens()).resolves.toEqual([{ symbol: 'XLM' }]);
    await jest.advanceTimersByTimeAsync(0);
    await expect(client.tokens()).resolves.toEqual([{ symbol: 'XLM' }]);
    jest.useRealTimers();
  });

  it('waits for a fresh list once the one it has is over an hour old', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T12:00:00Z') });
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return calls === 1 ? answer(200, [{ symbol: 'XLM' }]) : answer(502, {});
    });
    const client = makeClient();
    await client.tokens();

    jest.setSystemTime(new Date('2026-10-26T13:00:00Z'));
    await expect(client.tokens()).rejects.toBeInstanceOf(ApiError);
    jest.useRealTimers();
  });

  it('fetches the list at boot when asked to, and a failure there does not stop the boot', async () => {
    const fetch = mockFetch(() => answer(502, {}));
    makeClient({ prefetchTokens: false }).onApplicationBootstrap();
    expect(fetch).not.toHaveBeenCalled();

    expect(() =>
      makeClient({ prefetchTokens: true }).onApplicationBootstrap(),
    ).not.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://1click.example/v0/tokens');
    // The rejected prefetch is handled: let it settle without an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('a prefetched list serves the first caller with no request of its own', async () => {
    const fetch = mockFetch(() => answer(200, [{ symbol: 'XLM' }]));
    const client = makeClient({ prefetchTokens: true });
    client.onApplicationBootstrap();
    await expect(client.tokens()).resolves.toEqual([{ symbol: 'XLM' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('relays a 400 as provider_error with 1Click’s own reason', async () => {
    mockFetch(() =>
      answer(400, {
        message: 'Amount is too low for bridge, try at least 1000',
      }),
    );
    const err = await rejection(makeClient().quote({} as never));
    expect(err.getStatus()).toBe(400);
    expect(err.code).toBe(ApiErrorCode.ProviderError);
    expect(err.message).toContain('Amount is too low for bridge');
  });

  it('reports a refused partner key as misconfigured, not as the caller’s fault', async () => {
    mockFetch(() => answer(401, { message: 'Unauthorized' }));
    const err = await rejection(makeClient().quote({} as never));
    expect(err.getStatus()).toBe(503);
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
  });

  it('maps 1Click failing to 502 and a rate limit to 503', async () => {
    mockFetch(() => answer(500, {}));
    expect((await rejection(makeClient().tokens())).getStatus()).toBe(502);

    jest.restoreAllMocks();
    mockFetch(() => answer(429, {}));
    const limited = await rejection(makeClient().tokens());
    expect(limited.getStatus()).toBe(503);
    expect(limited.code).toBe(ApiErrorCode.ProviderUnavailable);
  });

  it('answers null for a deposit address 1Click does not know', async () => {
    const fetch = mockFetch(() => answer(404, { message: 'not found' }));
    await expect(makeClient().status('GDEP', '42')).resolves.toBeNull();
    expect(fetch.mock.calls[0][0]).toBe(
      'https://1click.example/v0/status?depositAddress=GDEP&depositMemo=42',
    );
  });

  it('reports a timeout as a 504', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );
    const err = await rejection(makeClient().tokens());
    expect(err.getStatus()).toBe(504);
    expect(err.code).toBe(ApiErrorCode.ProviderUnavailable);
  });
});
