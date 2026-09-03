import { Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { LOOPBACK_HOSTS } from '@/pollar/pollar.constants';

const log = new Logger('PollarRedirectUri');

/**
 * Per-consumer allow-list of the redirect URIs the bridge will hand a code to.
 * Env shape:
 * `POLLAR_REDIRECT_URI_WHITELIST={"cosmos_acme":["cosmospay://auth","http://127.0.0.1","https://app.acme.com"]}`
 *
 * Deliberately wider than the KYC `redirect_url` list, which only ever points at
 * an https site. A wallet finishing the code exchange on the user's own machine
 * has two other shapes, both blessed by RFC 8252 for native apps:
 *
 *   - a **loopback** listener on an ephemeral port (`http://127.0.0.1`), whose
 *     port cannot be known when the allow-list is written, and
 *   - a **private-use scheme** deep link (`cosmospay://auth`), which has no
 *     hostname at all and so cannot be matched by host.
 */
export type PollarRedirectWhitelist = Readonly<
  Record<string, readonly string[]>
>;

/**
 * Parse `POLLAR_REDIRECT_URI_WHITELIST` JSON. Invalid / empty input ⇒ {}, and
 * callers then fail closed per consumer — a consumer with no entries can still
 * run the poll flow, which addresses nothing and needs no allow-list.
 */
export function parsePollarRedirectWhitelist(
  raw: string | undefined,
): Record<string, string[]> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(
      'POLLAR_REDIRECT_URI_WHITELIST is not valid JSON; treating as empty (fail closed per consumer)',
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn(
      'POLLAR_REDIRECT_URI_WHITELIST must be a JSON object; treating as empty (fail closed per consumer)',
    );
    return {};
  }

  const out: Record<string, string[]> = {};
  for (const [consumer, entries] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const key = consumer.trim();
    if (!key || !Array.isArray(entries)) continue;
    out[key] = entries
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return out;
}

/** True when `url` is a loopback listener — any port, any path (RFC 8252 §7.3). */
function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

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

  if (isLoopback(allowed)) {
    return isLoopback(candidate) && allowed.hostname === candidate.hostname;
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
  if (candidate.protocol === 'http:' && !isLoopback(candidate)) {
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
