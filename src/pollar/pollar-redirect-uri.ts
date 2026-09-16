import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { PollarRedirectWhitelist } from '@/config/pollar-redirect-uri-whitelist';
import { isLoopbackHttpUrl } from '@/common/loopback';

// The allow-list itself — `POLLAR_REDIRECT_URI_WHITELIST`, and why it admits
// loopback and private-use-scheme URIs — is parsed and documented in
// `@/config/pollar-redirect-uri-whitelist`. This file is what an entry matches.

/**
 * Whether one allow-list entry covers `candidate`.
 *
 * Matching is per URI family, because "same origin" means something different in
 * each:
 *
 *   - **loopback** — the entry names the host only; the port is chosen at
 *     runtime by the wallet's listener and the path is the wallet's business.
 *   - **private-use scheme** — the entry is a prefix of the URI, so
 *     `cosmospay://auth` covers `cosmospay://auth/callback` but not the
 *     look-alike scheme `cosmospay-evil://auth`.
 *   - **https** — the entry is a hostname (exact or a parent domain), matching
 *     how the KYC list reads.
 */
function entryCovers(entry: string, candidate: URL): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;

  let allowed: URL;
  try {
    allowed = new URL(trimmed);
  } catch {
    // A bare hostname (`app.acme.com`) is a natural way to write an https entry
    // and is how the KYC list is configured, so keep accepting it.
    return (
      candidate.protocol === 'https:' &&
      hostMatches(candidate.hostname, trimmed)
    );
  }

  if (allowed.protocol !== candidate.protocol) return false;

  if (isLoopbackHttpUrl(allowed)) {
    return (
      isLoopbackHttpUrl(candidate) && allowed.hostname === candidate.hostname
    );
  }

  if (allowed.protocol === 'https:') {
    return hostMatches(candidate.hostname, allowed.hostname);
  }

  // Private-use scheme. Compare on the serialized URI so the match is a real
  // prefix and not a per-component approximation, and require the boundary to
  // land on a delimiter so `cosmospay://auth` cannot cover `cosmospay://authx`.
  const allowedHref = allowed.href.replace(/\/+$/, '');
  if (candidate.href === allowedHref) return true;
  if (!candidate.href.startsWith(allowedHref)) return false;
  const next = candidate.href.charAt(allowedHref.length);
  return next === '/' || next === '?' || next === '#';
}

/** Label-safe hostname match: exact, or a subdomain of the allowed domain. */
function hostMatches(hostname: string, allowedHost: string): boolean {
  const host = hostname.trim().toLowerCase();
  const allowed = allowedHost.trim().toLowerCase();
  if (!host || !allowed) return false;
  return host === allowed || host.endsWith(`.${allowed}`);
}

/**
 * Ensures `redirectUri` is one the consumer has registered, and returns it
 * normalized. Throws a 400 `validation_failed` otherwise.
 *
 * A redirect URI is where a single-use code is delivered, so an unvetted one is
 * a code-exfiltration channel — the reason this check exists at all, and the
 * reason an unconfigured consumer is refused rather than defaulted.
 */
export function assertPollarRedirectAllowed(
  consumerUsername: string,
  redirectUri: string,
  whitelist: PollarRedirectWhitelist,
): string {
  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_uri must be an absolute URI',
    );
  }

  if (candidate.username || candidate.password) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_uri must not carry embedded credentials',
    );
  }
  if (candidate.hash) {
    // The bridge appends `code` and `state` to the query. A fragment on the
    // registered URI would sit after them and silently swallow the redirect.
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_uri must not carry a fragment',
    );
  }
  if (candidate.protocol === 'http:' && !isLoopbackHttpUrl(candidate)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_uri must be https, a loopback address, or a private-use scheme',
    );
  }

  const allowed = whitelist[consumerUsername] ?? [];
  if (allowed.length === 0) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'no Pollar redirect_uri values are configured for this consumer; omit redirect_uri to use the poll flow',
    );
  }
  if (!allowed.some((entry) => entryCovers(entry, candidate))) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `redirect_uri '${redirectUri}' is not allowed for this consumer`,
    );
  }

  return candidate.toString();
}

/**
 * Appends the bridge's `code` and `state` to the wallet's redirect URI.
 *
 * `URL.searchParams` rather than string concatenation so a registered URI that
 * already carries a query (`cosmospay://auth?flow=signup`) keeps it.
 */
export function buildWalletRedirect(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
