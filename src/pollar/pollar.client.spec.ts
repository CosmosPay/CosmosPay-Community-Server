import { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import { PollarApiError, PollarClient } from '@/pollar/pollar.client';

function makeClient(overrides: Record<string, unknown> = {}) {
  const cfg = {
    publishableKey: { public: 'pub_mainnet_x', testnet: 'pub_testnet_x' },
    secretKey: { public: 'sec_mainnet_x', testnet: 'sec_testnet_x' },
    sdkBaseUrl: 'https://sdk.api.pollar.xyz',
    serverBaseUrl: 'https://api.pollar.xyz',
    bridgeCallbackUrl: 'https://gw.test/v1/pollar/oauth/callback',
    redirectUriWhitelist: {},
    timeoutMs: 5000,
    authorizationTtlMs: 300_000,
    codeTtlMs: 120_000,
    loginWaitMs: 20_000,
    sweep: { enabled: false, intervalMs: 60_000 },
    ...overrides,
  };
  const config = { get: () => cfg } as unknown as ConfigService<any, true>;
  return new PollarClient(config);
}

function mockFetch(impl: (url: string, init: any) => Partial<Response>) {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation((url: any, init: any) =>
      Promise.resolve(impl(String(url), init) as Response),
    );
}

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

afterEach(() => jest.restoreAllMocks());

describe('key separation', () => {
  it('sends the publishable key to the SDK API', async () => {
    const spy = mockFetch(() => ok({ success: true, content: { a: 1 } }));

    await makeClient().sdk('POST', 'testnet', '/auth/session');

    const [url, init] = spy.mock.calls[0] as any;
    expect(url).toBe('https://sdk.api.pollar.xyz/v2/auth/session');
    expect(init.headers['x-pollar-api-key']).toBe('pub_testnet_x');
  });

  it('sends the secret key to the Server API', async () => {
    const spy = mockFetch(() => ok({ success: true, content: { a: 1 } }));

    await makeClient().server('POST', 'testnet', '/wallets/activate');

    const [url, init] = spy.mock.calls[0] as any;
    expect(url).toBe('https://api.pollar.xyz/v1/wallets/activate');
    // Pollar refuses a publishable key here outright, so picking the key must
    // not be something a call site can get wrong — hence two methods.
    expect(init.headers['x-pollar-api-key']).toBe('sec_testnet_x');
  });

  it('picks the pair for the network it was asked for', async () => {
    const spy = mockFetch(() => ok({ success: true, content: {} }));
    const client = makeClient();

    await client.sdk('POST', 'public', '/auth/session');
    await client.server('POST', 'public', '/wallets/activate');

    expect((spy.mock.calls[0][1] as any).headers['x-pollar-api-key']).toBe(
      'pub_mainnet_x',
    );
    expect((spy.mock.calls[1][1] as any).headers['x-pollar-api-key']).toBe(
      'sec_mainnet_x',
    );
  });

  it('reports a missing key as a 503 rather than calling with an empty one', async () => {
    const spy = mockFetch(() => ok({ success: true, content: {} }));
    const client = makeClient({
      publishableKey: { public: '', testnet: '' },
    });

    await expect(
      client.sdk('POST', 'testnet', '/auth/session'),
    ).rejects.toThrow(/not configured for testnet/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the response envelope', () => {
  it('unwraps `content`', async () => {
    mockFetch(() =>
      ok({
        success: true,
        code: 'SDK_SESSION_CREATED',
        content: { id: 'cs_1' },
      }),
    );

    await expect(
      makeClient().sdk('POST', 'testnet', '/auth/session'),
    ).resolves.toEqual({ id: 'cs_1' });
  });

  it('raises a 2xx that says `success: false`', async () => {
    // Pollar can answer 200 with a failure envelope; treating that as success
    // would hand the caller an undefined token.
    mockFetch(() => ok({ success: false, code: 'WALLET_NOT_FOUND' }));

    await expect(
      makeClient().server('POST', 'testnet', '/wallets/activate'),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('raises a 2xx with no content rather than returning undefined', async () => {
    mockFetch(() => ok({ success: true, code: 'OK' }));

    await expect(
      makeClient().sdk('POST', 'testnet', '/auth/login'),
    ).rejects.toThrow(/unexpected response/);
  });

  it('keeps Pollar’s own code on an error, for the caller to branch on', async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      text: () =>
        Promise.resolve(
          JSON.stringify({ success: false, code: 'WALLET_ALREADY_FUNDED' }),
        ),
    }));

    const err = await makeClient()
      .server('POST', 'testnet', '/wallets/activate')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollarApiError);
    expect(err).toMatchObject({ status: 409, code: 'WALLET_ALREADY_FUNDED' });
  });

  it('synthesises a code when the body is not an envelope at all', async () => {
    // A gateway HTML error page, say. The caller still gets something stable.
    mockFetch(() => ({
      ok: false,
      status: 502,
      text: () => Promise.resolve('<html>bad gateway</html>'),
    }));

    await expect(
      makeClient().sdk('POST', 'testnet', '/auth/login'),
    ).rejects.toMatchObject({ code: 'HTTP_502' });
  });
});

describe('the access token', () => {
  it('is attached as a bearer when supplied', async () => {
    const spy = mockFetch(() => ok({ success: true, content: { revoked: 1 } }));

    await makeClient().sdk('POST', 'testnet', '/auth/logout', {
      accessToken: 'at_1',
      body: { everywhere: false },
    });

    expect((spy.mock.calls[0][1] as any).headers.authorization).toBe(
      'Bearer at_1',
    );
  });

  it('is absent when not supplied — refresh must not carry one', async () => {
    const spy = mockFetch(() => ok({ success: true, content: { token: {} } }));

    await makeClient().sdk('POST', 'testnet', '/auth/refresh', {
      body: { refreshToken: 'rt_1' },
    });

    expect((spy.mock.calls[0][1] as any).headers.authorization).toBeUndefined();
  });
});

describe('transport failures', () => {
  it('turns a timeout into a 504, not a generic 500', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(
      makeClient().sdk('GET', 'testnet', '/auth/session/status/x/poll'),
    ).rejects.toMatchObject({ status: HttpStatus.GATEWAY_TIMEOUT });
  });

  it('turns an unreachable host into a 502', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1'));

    const err: any = await makeClient()
      .sdk('POST', 'testnet', '/auth/session')
      .catch((e: unknown) => e);

    expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    // The transport detail names internal hosts and is ours to debug, not the
    // caller's to read.
    expect(JSON.stringify(err.getResponse())).not.toContain('10.0.0.1');
  });

  it('honours a per-call timeout override', async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'fetch').mockImplementation(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const pending = makeClient()
      .sdk('GET', 'testnet', '/auth/session/status/x/poll', { timeoutMs: 1000 })
      .catch((e: unknown) => e);
    jest.advanceTimersByTime(1000);

    await expect(pending).resolves.toMatchObject({
      status: HttpStatus.GATEWAY_TIMEOUT,
    });
    expect(spy).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('callbackUrl', () => {
  it('appends the state to the configured callback', () => {
    expect(makeClient().callbackUrl('st_1')).toBe(
      'https://gw.test/v1/pollar/oauth/callback/st_1',
    );
  });

  it('escapes a state that would otherwise change the path', () => {
    expect(makeClient().callbackUrl('a/b')).toBe(
      'https://gw.test/v1/pollar/oauth/callback/a%2Fb',
    );
  });

  it('refuses when no callback URL is configured', () => {
    // Better here than as a redirect Pollar silently rejects later.
    expect(() =>
      makeClient({ bridgeCallbackUrl: '' }).callbackUrl('st'),
    ).toThrow(/POLLAR_BRIDGE_CALLBACK_URL/);
  });
});
