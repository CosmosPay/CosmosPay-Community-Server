import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import { BLOCKED_HOSTNAMES } from '@/webhooks/webhooks.constants';

/**
 * Outbound webhook destinations must be public HTTPS endpoints.
 * Resolves DNS and rejects loopback, private, link-local, and cloud-metadata targets
 * (SSRF hardening). Used at register time and again immediately before delivery,
 * which then connects to the address this returned rather than resolving again.
 */

export class WebhookUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlValidationError';
  }
}

/** Resolves a hostname to one or more IP addresses (IPv4 and/or IPv6). */
export type DnsLookupFn = (hostname: string) => Promise<string[]>;

/**
 * A destination that passed validation, carrying everything the caller needs to
 * open the connection **to the address that was actually checked**.
 *
 * Returning the address is what makes the check mean anything. Validating a
 * hostname and then handing that hostname to `fetch` (or to `https.request`
 * without a pinned `lookup`) resolves DNS a second time, so the address that was
 * validated is never the address that is connected to: a record with a
 * one-second TTL alternating between a public IP and `169.254.169.254` passes
 * here and is then fetched at the cloud metadata service. Callers must connect
 * to {@link address} and keep {@link hostname} for the `Host` header, the SNI
 * extension and certificate verification — see `postWebhook`.
 */
export interface ValidatedWebhookDestination {
  /** Hostname as registered — for `Host`, SNI and certificate verification. */
  hostname: string;
  port: number;
  /** The literal IP the socket must connect to. */
  address: string;
  family: 4 | 6;
}

export const DEFAULT_DNS_LOOKUP: DnsLookupFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

/**
 * Validates that `rawUrl` is an https URL whose resolved address(es) are public,
 * and returns the destination to pin the connection to.
 * Throws {@link WebhookUrlValidationError} when the destination is not allowed.
 */
export async function assertPublicWebhookUrl(
  rawUrl: string,
  lookup: DnsLookupFn = DEFAULT_DNS_LOOKUP,
): Promise<ValidatedWebhookDestination> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebhookUrlValidationError(
      'Webhook URL is not a valid absolute URL',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new WebhookUrlValidationError(
      'Webhook URL must use the https scheme',
    );
  }

  if (parsed.username || parsed.password) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not include credentials',
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    throw new WebhookUrlValidationError('Webhook URL is missing a host');
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new WebhookUrlValidationError(
      'Webhook URL host is not allowed (cloud metadata)',
    );
  }

  const port = parsed.port ? Number(parsed.port) : 443;

  const ipVersion = isIP(hostname);
  if (ipVersion) {
    assertAddressAllowed(hostname, ipVersion);
    return { hostname, port, address: hostname, family: ipVersion as 4 | 6 };
  }

  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new WebhookUrlValidationError(
      `Webhook URL host could not be resolved: ${hostname}`,
    );
  }

  if (addresses.length === 0) {
    throw new WebhookUrlValidationError(
      `Webhook URL host resolved to no addresses: ${hostname}`,
    );
  }

  for (const address of addresses) {
    const version = isIP(address);
    if (!version) {
      throw new WebhookUrlValidationError(
        `Webhook URL resolved to an unrecognised address: ${address}`,
      );
    }
    assertAddressAllowed(address, version);
  }

  // Every answer was just checked, so pinning any of them connects to an
  // address we validated; take the first, the order the resolver preferred.
  const [address] = addresses;
  return { hostname, port, address, family: isIP(address) as 4 | 6 };
}

function assertAddressAllowed(address: string, version: number): void {
  if (version === 4) {
    assertIpv4Allowed(address);
    return;
  }
  assertIpv6Allowed(address);
}

function assertIpv4Allowed(address: string): void {
  const parts = address.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new WebhookUrlValidationError(`Invalid IPv4 address: ${address}`);
  }
  const [a, b, c] = parts;

  // Loopback 127.0.0.0/8
  if (a === 127) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a loopback address',
    );
  }
  // "This" network 0.0.0.0/8
  if (a === 0) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a non-routable address',
    );
  }
  // Private 10.0.0.0/8
  if (a === 10) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a private address',
    );
  }
  // Private 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a private address',
    );
  }
  // Private 192.168.0.0/16
  if (a === 192 && b === 168) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a private address',
    );
  }
  // IETF protocol assignments 192.0.0.0/24 — not globally routable, and the
  // block holds special-purpose addresses (DS-Lite 192.0.0.1, NAT64 discovery)
  // that resolve on-network rather than on the internet.
  if (a === 192 && b === 0 && c === 0) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a reserved address',
    );
  }
  // Link-local 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a link-local or cloud-metadata address',
    );
  }
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a shared/CGNAT address',
    );
  }
  // Benchmarking 198.18.0.0/15 — RFC 2544 test range, routed to lab gear
  // inside a network rather than to the internet.
  if (a === 198 && (b === 18 || b === 19)) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a benchmarking address',
    );
  }
  // Multicast / reserved 224.0.0.0/4 and above
  if (a >= 224) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a reserved address',
    );
  }
}

function assertIpv6Allowed(address: string): void {
  const normalized = expandIpv6(address);

  // Loopback ::1
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a loopback address',
    );
  }
  // Unspecified ::
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0000') {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a non-routable address',
    );
  }

  const first = Number.parseInt(normalized.slice(0, 4), 16);

  // Unique-local fc00::/7
  if ((first & 0xfe00) === 0xfc00) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a private address',
    );
  }
  // Link-local fe80::/10
  if ((first & 0xffc0) === 0xfe80) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a link-local address',
    );
  }
  // Multicast ff00::/8
  if ((first & 0xff00) === 0xff00) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a reserved address',
    );
  }

  // 6to4 2002::/16. The 32 bits after the prefix *are* an IPv4 address the
  // relay connects to on our behalf, so `2002:a9fe:a9fe::` is 169.254.169.254
  // smuggled past every v4 check above. The transition mechanism is deprecated
  // (RFC 7526) and no real integrator is reachable only this way.
  if (normalized.startsWith('2002:')) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a 6to4 address',
    );
  }
  // NAT64 64:ff9b::/32 (the well-known /96 plus the local-use 64:ff9b:1::/48).
  // Same shape of problem: the low 32 bits are handed to a translator that
  // opens the connection as IPv4, which may land anywhere private.
  if (normalized.startsWith('0064:ff9b:')) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a NAT64 address',
    );
  }

  // Teredo 2001:0000::/32. Embeds a server and a client IPv4 address and
  // tunnels to IPv4 — the same class as 6to4 above, and equally not how any
  // real integrator is reachable.
  if (normalized.startsWith('2001:0000:')) {
    throw new WebhookUrlValidationError(
      'Webhook URL must not resolve to a Teredo address',
    );
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4.
  if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const mapped = ipv4FromMappedIpv6(normalized);
    if (mapped) {
      assertIpv4Allowed(mapped);
    }
  }

  // IPv4-compatible IPv6 (::a.b.c.d) — the deprecated sibling of the mapped
  // form, and the one the checks above all miss. `::169.254.169.254` expands to
  // 0000:…:a9fe:a9fe: not ::1, not ::, not ULA, not link-local, not multicast,
  // no 2002:/0064:ff9b: prefix, and the mapped re-check keys on ::ffff: — so it
  // walked straight through to the cloud metadata service.
  if (
    normalized.startsWith('0000:0000:0000:0000:0000:0000:') &&
    !normalized.endsWith(':0000:0000') // plain :: and ::1 are handled above
  ) {
    const embedded = ipv4FromMappedIpv6(
      normalized.replace(
        '0000:0000:0000:0000:0000:0000:',
        '0000:0000:0000:0000:0000:ffff:',
      ),
    );
    if (embedded) {
      assertIpv4Allowed(embedded);
    }
  }
}

function expandIpv6(address: string): string {
  const lower = address.toLowerCase();
  if (lower.includes('.')) {
    // e.g. ::ffff:127.0.0.1
    const lastColon = lower.lastIndexOf(':');
    const v6Part = lower.slice(0, lastColon);
    const v4Part = lower.slice(lastColon + 1);
    const [a, b, c, d] = v4Part.split('.').map((n) => Number(n));
    const hi = ((a << 8) | b).toString(16).padStart(4, '0');
    const lo = ((c << 8) | d).toString(16).padStart(4, '0');
    return expandIpv6(`${v6Part}:${hi}:${lo}`);
  }

  const [head, tail] = lower.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - (headParts.length + tailParts.length);
  const parts: string[] = [
    ...headParts,
    ...Array<string>(Math.max(missing, 0)).fill('0'),
    ...tailParts,
  ];
  return parts.map((p) => p.padStart(4, '0')).join(':');
}

function ipv4FromMappedIpv6(expanded: string): string | null {
  const parts = expanded.split(':');
  if (parts.length !== 8) return null;
  const hi = Number.parseInt(parts[6], 16);
  const lo = Number.parseInt(parts[7], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
