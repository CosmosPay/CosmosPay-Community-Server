import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { LookupAddress } from 'node:dns';

jest.mock('node:https', () => ({
  __esModule: true,
  request: jest.fn(),
}));

import { request as httpsRequest } from 'node:https';
import { jitteredBackoffMs, postWebhook } from './webhook-http';
import type { ValidatedWebhookDestination } from './webhook-url.validator';

type RequestCall = { options: any; body: string };

/**
 * Stands in for `https.request`: records the options the transport chose and
 * replays a canned response, so the pinning can be asserted without opening a
 * socket (the whole point is that a socket must never reach an unvalidated
 * address).
 */
function stubHttps(
  response: { statusCode: number; chunks?: string[] } | Error,
) {
  const calls: RequestCall[] = [];
  (httpsRequest as unknown as jest.Mock).mockImplementation(
    (options: any, callback: (res: any) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
      };
      req.end = (body: string) => {
        calls.push({ options, body });
        setImmediate(() => {
          if (response instanceof Error) {
            req.emit('error', response);
            return;
          }
          const incoming = Readable.from(response.chunks ?? []) as Readable & {
            statusCode?: number;
          };
          incoming.statusCode = response.statusCode;
          callback(incoming);
        });
      };
      return req;
    },
  );
  return calls;
}

const destination: ValidatedWebhookDestination = {
  hostname: 'integrator.example.com',
  port: 443,
  address: '93.184.216.34',
  family: 4,
};

const limits = {
  connectTimeoutMs: 500,
  readTimeoutMs: 1000,
  maxResponseBytes: 16,
};

function post(overrides: Partial<Parameters<typeof postWebhook>[0]> = {}) {
  return postWebhook({
    url: 'https://integrator.example.com/hook?x=1',
    destination,
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
    limits,
    ...overrides,
  });
}

describe('postWebhook (DNS pinning)', () => {
  beforeEach(() => (httpsRequest as unknown as jest.Mock).mockReset());

  it('connects to the validated address while keeping the hostname for Host/SNI', async () => {
    const calls = stubHttps({ statusCode: 200 });

    await expect(post()).resolves.toEqual({ status: 200, ok: true });

    const { options, body } = calls[0];
    // The certificate is still verified against the registered hostname, and
    // the receiver still sees its own name in `Host` — pinning must not turn
    // into "connect to an IP and hope".
    expect(options.host).toBe('integrator.example.com');
    expect(options.servername).toBe('integrator.example.com');
    expect(options.port).toBe(443);
    expect(options.path).toBe('/hook?x=1');
    expect(options.method).toBe('POST');
    expect(options.headers['content-length']).toBe('7');
    expect(body).toBe('{"a":1}');
    // Never weaken verification, never pool a socket across pins.
    expect(options.rejectUnauthorized).toBeUndefined();
    expect(options.agent).toBe(false);
  });

  it('resolves the hostname to the pre-validated address, never re-querying DNS', async () => {
    const calls = stubHttps({ statusCode: 204 });
    await post();

    const lookup = calls[0].options.lookup as (
      hostname: string,
      options: { all?: boolean },
      cb: (
        err: Error | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => void;
    expect(typeof lookup).toBe('function');

    // Single-answer form.
    const one = jest.fn();
    lookup('integrator.example.com', {}, one);
    expect(one).toHaveBeenCalledWith(null, '93.184.216.34', 4);

    // Happy-eyeballs form (`autoSelectFamily` asks for every answer).
    const all = jest.fn();
    lookup('integrator.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('reports a redirect as a non-2xx status instead of following it', async () => {
    const calls = stubHttps({ statusCode: 302 });
    await expect(post()).resolves.toEqual({ status: 302, ok: false });
    // One request, to the registered destination — nothing chased the Location.
    expect(calls).toHaveLength(1);
    expect(httpsRequest as unknown as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the response body exceeds the size limit', async () => {
    stubHttps({ statusCode: 200, chunks: ['x'.repeat(64)] });
    await expect(post()).rejects.toThrow(/exceeded size limit of 16 bytes/);
  });

  it('rejects transport errors', async () => {
    stubHttps(new Error('socket hang up'));
    await expect(post()).rejects.toThrow(/socket hang up/);
  });
});

describe('jitteredBackoffMs', () => {
  it('spreads each tier over [base/2, base] so retries do not resynchronize', () => {
    // Tier 2 of a 2000ms base is 4000ms; jitter keeps half as the floor.
    expect(jitteredBackoffMs(2000, 1, () => 0)).toBe(2000);
    expect(jitteredBackoffMs(2000, 1, () => 1)).toBe(4000);
    expect(jitteredBackoffMs(2000, 1, () => 0.5)).toBe(3000);
  });

  it('gives two senders different delays for the same attempt', () => {
    const a = jitteredBackoffMs(1000, 0, () => 0.1);
    const b = jitteredBackoffMs(1000, 0, () => 0.9);
    expect(a).not.toBe(b);
    for (const delay of [a, b]) {
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });
});
