/**
 * Hosts that count as a loopback target, and the rule that reads them.
 *
 * Two checks need it, in different modules: a native wallet's Pollar redirect
 * URI listens on an ephemeral loopback port (RFC 8252 §7.3), and
 * `POLLAR_BRIDGE_CALLBACK_URL` must be https unless it points at the machine the
 * developer is on. One definition, so "is this local?" cannot come out
 * differently in the two places.
 *
 * `[::1]` carries its brackets because that is what `URL.hostname` returns for
 * an IPv6 host.
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** True when `url` is plain http to a loopback host — any port, any path. */
export function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}
