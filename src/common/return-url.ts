import {
  FORBIDDEN_RETURN_SCHEMES,
  LOOPBACK_RETURN_HOSTS,
} from '@/common/return-url.constants';

/**
 * Where a provider callback sends the browser once it is done, for a wallet that
 * asked to be taken back instead of left on a page.
 *
 * A native wallet opens the sign-in in the platform's auth session —
 * `ASWebAuthenticationSession`, an Android Custom Tab, the system browser from a
 * desktop app — and that session only closes itself when the browser reaches a
 * URL the app owns. The callback page this service renders is not one, so without
 * a redirect the person is left looking at "go back to your wallet" and has to
 * dismiss the sheet by hand.
 *
 * What travels in the redirect is the `state` and, on failure, a reason token:
 * exactly what the browser already had in its address bar. The identity is still
 * collected by the device presenting the PKCE verifier, so an app that hijacks the
 * scheme receives nothing it can redeem. The allowlist is what keeps this from
 * being an open redirect off the service's own domain.
 */

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_RETURN_HOSTS.has(url.hostname);
}

/**
 * Why a URL cannot be a return URL, or null when it can.
 *
 * Applied to every allowlist entry at boot and to every candidate a wallet sends.
 * A query or fragment is refused rather than merged: the redirect owns the query
 * string, and an entry with one is an entry whose match rule nobody can state.
 */
export function returnUrlProblem(value: string): string | null {
  const url = parse(value);
  if (!url) return 'is not an absolute URL';
  if (FORBIDDEN_RETURN_SCHEMES.has(url.protocol))
    return `uses the ${url.protocol} scheme`;
  if (url.username || url.password) return 'carries credentials';
  if (url.search || url.hash) return 'carries a query or fragment';
  if (url.protocol === 'http:' && !isLoopback(url))
    return 'is plain http off the loopback interface (use https, a custom scheme, or 127.0.0.1)';
  return null;
}

/**
 * Whether `candidate` is one of the operator's return URLs.
 *
 * Scheme, host and path are compared exactly. The port is too, except against a
 * loopback entry, where it is ignored (RFC 8252 §7.3).
 */
export function isReturnUrlAllowed(
  candidate: string,
  allowlist: readonly string[],
): boolean {
  if (returnUrlProblem(candidate) !== null) return false;
  const url = parse(candidate);
  if (!url) return false;
  return allowlist.some((entry) => {
    const allowed = parse(entry);
    if (!allowed || returnUrlProblem(entry) !== null) return false;
    if (allowed.protocol !== url.protocol) return false;
    if (allowed.hostname !== url.hostname) return false;
    if (allowed.pathname !== url.pathname) return false;
    return isLoopback(allowed) || allowed.port === url.port;
  });
}

/**
 * The URL the callback redirects to: the wallet's return URL with the `state`,
 * plus `error=<reason>` when the sign-in did not succeed.
 *
 * The reason is the same token the poll reports and the callback page maps to a
 * sentence — never prose. The wallet should still poll (or claim) for the answer:
 * this redirect only tells it the browser is done.
 */
export function returnRedirectUrl(
  returnTo: string,
  state: string,
  reason: string,
): string {
  const url = new URL(returnTo);
  url.searchParams.set('state', state);
  if (reason !== 'ok') url.searchParams.set('error', reason);
  return url.toString();
}

/** `WALLET_AUTH_RETURN_URLS`, comma-separated, as the list the rules above read. */
export function parseReturnUrls(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
