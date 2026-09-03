import type { Request } from 'express';

/**
 * The client address a rate limit is keyed on.
 *
 * **Why `req.ip` is trustworthy here, and only here.** `main.ts` sets
 * `trust proxy` to `1`, which makes Express take the *rightmost* entry of
 * `X-Forwarded-For` — the one the last proxy appended, i.e. the peer as APISIX
 * saw it. A client can prepend whatever it likes to that header, but everything
 * it writes lands to the *left* of APISIX's entry and is therefore ignored.
 *
 * That single digit is load-bearing: raising it to `2` would start honouring
 * the first client-supplied hop and make every limit here bypassable by adding
 * one header. `client-ip.spec.ts` pins the behaviour so the change cannot pass
 * unnoticed.
 */
export function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return normalizeIp(ip);
}

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:1.2.3.4` and `1.2.3.4` agree. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return 'unknown';
  return trimmed.startsWith('::ffff:')
    ? trimmed.slice('::ffff:'.length)
    : trimmed;
}

/**
 * The bucket an address counts against.
 *
 * IPv4 buckets per address. IPv6 buckets per `/64`, because a residential or
 * cloud IPv6 client is routinely handed an entire /64 and can rotate through
 * 18 quintillion addresses inside it at no cost — a per-address limit there is
 * not a limit at all. /64 is the smallest block that is always assigned as a
 * unit, so it is the narrowest key that cannot be trivially widened.
 *
 * The cost of this is honest and worth stating: two unrelated users behind one
 * /64 share a bucket, exactly as two users behind one IPv4 NAT already do.
 */
export function rateLimitSubject(ip: string): string {
  const normalized = normalizeIp(ip);
  if (!normalized.includes(':')) return normalized;

  // Expand only as far as needed to take the first four groups.
  const [head] = normalized.split('%'); // drop any zone id
  const groups = expandIpv6Prefix(head ?? normalized);
  return groups ? `${groups}::/64` : normalized;
}

/** First four hextets of an IPv6 address, or null if it cannot be read. */
function expandIpv6Prefix(address: string): string | null {
  const parts = address.split('::');
  if (parts.length > 2) return null;

  const head = (parts[0] ?? '').split(':').filter(Boolean);
  if (parts.length === 1) {
    return head.length >= 4 ? head.slice(0, 4).join(':') : null;
  }

  // `a::b` — the elision only adds zeroes, so a head of four groups already
  // determines the /64; anything shorter is padded with the zeroes it implies.
  const tail = (parts[1] ?? '').split(':').filter(Boolean);
  const zeros = Math.max(0, 8 - head.length - tail.length);
  const full = [...head, ...Array<string>(zeros).fill('0'), ...tail];
  return full.length >= 4 ? full.slice(0, 4).join(':') : null;
}
