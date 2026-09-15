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
 * Ensures `redirectUrl` targets a hostname on the consumer's allow-list.
 * Throws a `400 validation_failed` {@link ApiError} on failure.
 *
 * The list is `KYC_REDIRECT_URL_WHITELIST`, parsed at boot in
 * `@/config/kyc-redirect-url-whitelist`; this is only the rule that applies it.
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

  let hostname: string;
  try {
    hostname = new URL(redirectUrl).hostname;
  } catch {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'redirect_url must be a valid https URL without embedded credentials',
    );
  }

  if (!hostnameAllowed(hostname, allowed)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `redirect_url hostname '${hostname}' is not allowed for this consumer`,
    );
  }
}
