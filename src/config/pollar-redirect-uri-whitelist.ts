import { Logger } from '@nestjs/common';

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
 *
 * Parsed here, with the rest of the environment, and enforced in
 * `@/pollar/pollar-redirect-uri` (`assertPollarRedirectAllowed`), which owns what
 * each entry matches. Configuration loads before every feature module, so it
 * must not import one to read a variable.
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
