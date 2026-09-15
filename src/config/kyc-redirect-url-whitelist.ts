import { Logger } from '@nestjs/common';

const log = new Logger('RedirectUrlWhitelist');

/**
 * Per-consumer allow-list of redirect_url hostnames for the KYC ToS flow
 * (issue #33). Env shape:
 * `KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}`
 *
 * Parsed here, with the rest of the environment, and enforced in
 * `@/kyc/redirect-url-whitelist` (`assertRedirectAllowed`). Configuration loads
 * before every feature module, so it must not import one to read a variable.
 */
export type RedirectUrlWhitelist = Readonly<Record<string, readonly string[]>>;

/**
 * Parse `KYC_REDIRECT_URL_WHITELIST` JSON. Invalid / empty input ⇒ {}
 * (callers fail closed per consumer when the list is missing/empty).
 */
export function parseRedirectUrlWhitelist(
  raw: string | undefined,
): Record<string, string[]> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(
      'KYC_REDIRECT_URL_WHITELIST is not valid JSON; treating as empty (fail closed per consumer)',
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn(
      'KYC_REDIRECT_URL_WHITELIST must be a JSON object; treating as empty (fail closed per consumer)',
    );
    return {};
  }

  const out: Record<string, string[]> = {};
  for (const [consumer, domains] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const key = consumer.trim();
    if (!key || !Array.isArray(domains)) continue;
    const cleaned = domains
      .filter((d): d is string => typeof d === 'string')
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
    out[key] = cleaned;
  }
  return out;
}
