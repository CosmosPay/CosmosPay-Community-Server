import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { RedirectUrlWhitelist } from '@/config/kyc-redirect-url-whitelist';

/** Label-safe hostname match: exact or subdomain of an allowed domain. */
export function hostnameAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  for (const domain of allowedDomains) {
    const allowed = domain.trim().toLowerCase();
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * Whether the string carries a character that makes two parsers disagree about
 * where the URL points.
 *
 * The backslash is the one that matters. WHATWG maps it to `/` inside the
 * authority, so `https://allowed.test\@evil.test` has hostname `allowed.test`
 * here — and userinfo `allowed.test` with host `evil.test` for a parser that does
 * not. This service is not the last thing to read the value: it goes to BlindPay,
 * comes back on a hosted page and ends in a browser, so it cannot decide which
 * reading wins. Whitespace and control characters are the same class, since a
 * reader that strips them reaches a host the check never saw.
 */
function hasAmbiguousChars(raw: string): boolean {
  if (/[\\\s]/.test(raw)) return true;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Ensures `redirectUrl` is an https URL on the consumer's allow-list and that
 * nothing about it would be read differently downstream. Throws a
 * `400 validation_failed` {@link ApiError} on failure.
 *
 * The allow-list is `KYC_REDIRECT_URL_WHITELIST`, parsed at boot in
 * `@/config/kyc-redirect-url-whitelist`; this is only the rule that applies it.
 * The rest is what the hostname match is worth: a scheme that is not https puts
 * the `tos_id` in clear, embedded credentials make the host the part after the
 * `@` for some readers, and a fragment swallows the `?tos_id=` the provider
 * appends.
 *
 * https with no exception, including loopback: `@IsRedirectUrl()` on the DTOs
 * has always refused plain http and this is the layer behind it, so an exception
 * here would only ever be laxer than the one check every caller passes first.
 */
export function assertRedirectAllowed(
  consumerUsername: string,
  redirectUrl: string,
  whitelist: RedirectUrlWhitelist,
): void {
  const allowed = whitelist[consumerUsername] ?? [];
  if (allowed.length === 0) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'no redirect_url domains are configured for this consumer',
    );
  }

  if (hasAmbiguousChars(redirectUrl)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_url must not contain backslashes, whitespace or control characters',
    );
  }

  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_url must be a valid https URL without embedded credentials',
    );
  }

  if (url.protocol !== 'https:') {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_url must use the https scheme',
    );
  }
  if (url.username || url.password) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_url must not carry embedded credentials',
    );
  }
  if (url.hash) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_url must not carry a fragment: the provider appends `?tos_id=` after it',
    );
  }

  if (!hostnameAllowed(url.hostname, allowed)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `redirect_url hostname '${url.hostname}' is not allowed for this consumer`,
    );
  }
}
