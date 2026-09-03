import { clientIp, normalizeIp, rateLimitSubject } from '@/common/client-ip';

// Express's own resolver, reached through `require` because it ships no types
// and this is the one place worth reaching for it: asserting against a
// re-implementation would only prove the re-implementation agrees with itself.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyaddr = require('proxy-addr') as (
  req: unknown,
  trust: (addr: string, i: number) => boolean,
) => string;

/**
 * Express compiles a numeric `trust proxy` into "trust the first n hops from
 * the socket". Reproduced here so the assertions below test the real semantics
 * of the value `main.ts` sets, not a paraphrase of them.
 */
const trustHops = (n: number) => (_addr: string, i: number) => i < n;

function requestWith(forwardedFor: string, socket = '10.0.0.5'): any {
  return {
    headers: { 'x-forwarded-for': forwardedFor },
    connection: { remoteAddress: socket },
    socket: { remoteAddress: socket },
  };
}

describe('trust proxy = 1 (the value main.ts sets)', () => {
  it('takes the entry APISIX appended, not the one the client wrote', () => {
    // A client that prepends its own X-Forwarded-For lands to the LEFT of the
    // address APISIX appends, so the spoof is ignored. If this ever flips, every
    // per-address limit in the service becomes bypassable with one header.
    const req = requestWith('9.9.9.9, 203.0.113.7');
    expect(proxyaddr(req, trustHops(1))).toBe('203.0.113.7');
  });

  it('would honour the spoof at trust proxy = 2 — do not raise it', () => {
    const req = requestWith('9.9.9.9, 203.0.113.7');
    expect(proxyaddr(req, trustHops(2))).toBe('9.9.9.9');
  });
});

describe('clientIp', () => {
  it('reads req.ip, which Express has already resolved', () => {
    expect(clientIp({ ip: '203.0.113.7' } as any)).toBe('203.0.113.7');
  });

  it('falls back to the socket when there is no resolved ip', () => {
    expect(clientIp({ socket: { remoteAddress: '198.51.100.4' } } as any)).toBe(
      '198.51.100.4',
    );
  });

  it('never returns an empty key', () => {
    expect(clientIp({} as any)).toBe('unknown');
  });
});

describe('normalizeIp', () => {
  it('collapses the IPv4-mapped form onto the plain one', () => {
    // Otherwise the same client gets two buckets depending on how the socket
    // happened to be opened, and each bucket has the full budget.
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('lowercases and trims', () => {
    expect(normalizeIp('  2001:DB8::1 ')).toBe('2001:db8::1');
  });
});

describe('rateLimitSubject', () => {
  it('buckets IPv4 per address', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('203.0.113.8')).not.toBe(
      rateLimitSubject('203.0.113.7'),
    );
  });

  it('buckets IPv6 per /64, so rotating inside a prefix buys nothing', () => {
    // A client handed a /64 can move through 2^64 addresses for free; per-address
    // limiting there is not limiting.
    const a = rateLimitSubject('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = rateLimitSubject('2001:db8:1:2:ffff:0:0:1');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
  });

  it('separates different /64s', () => {
    expect(rateLimitSubject('2001:db8:1:2::1')).not.toBe(
      rateLimitSubject('2001:db8:1:3::1'),
    );
  });

  it('expands an elided address before taking the prefix', () => {
    expect(rateLimitSubject('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64');
  });

  it('drops a zone id rather than bucketing on it', () => {
    expect(rateLimitSubject('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('falls back to the address itself when it cannot be parsed', () => {
    expect(rateLimitSubject('not:an:ip::x::y')).toBe('not:an:ip::x::y');
  });
});
