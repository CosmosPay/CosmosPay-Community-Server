import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CONSOLE_MARKER_LABEL,
  CONSOLE_MARKER_MAX_SKEW_S,
  CONSOLE_MARKER_VERSION,
} from '@/admin/admin.constants';

/**
 * The platform console's proof that a call came from it: a MAC over a timestamp,
 * keyed by the gateway secret.
 *
 * The marker used to be the literal `1`, and what made it trustworthy was that
 * APISIX strips `X-Cosmos-Internal` from every request it proxies. That made the
 * whole cross-tenant surface — and the rate-limit exemption that rides on the
 * same flag — one routing mistake away from any API key: a route that forgot the
 * strip handed both to whoever sent the header. A MAC cannot be produced without
 * the gateway secret, which API-key callers never hold, so a route that forgets
 * the strip now forwards a value nobody outside could have minted.
 *
 * The key is the secret both sides already share, so there is still no second
 * credential to deploy or rotate. The timestamp bounds what a marker that leaks
 * into a log is worth: {@link CONSOLE_MARKER_MAX_SKEW_S} seconds, not forever.
 */

/** `HMAC-SHA256(secret, LABEL + ts)` as lowercase hex. */
function mac(secret: string, ts: number): string {
  return createHmac('sha256', secret)
    .update(CONSOLE_MARKER_LABEL + String(ts))
    .digest('hex');
}

/**
 * Mints a marker for `nowMs`. The service never sends one; this is the reference
 * the dev platform's copy is tested against, and what the test suites use.
 */
export function signConsoleMarker(secret: string, nowMs: number): string {
  const ts = Math.floor(nowMs / 1000);
  return `${CONSOLE_MARKER_VERSION}.${ts}.${mac(secret, ts)}`;
}

/**
 * Whether `raw` is a marker minted with `secret` within the skew window. Fails
 * closed on everything else: no secret configured, a bare `1`, a wrong version,
 * a malformed or out-of-window timestamp, a MAC of the wrong length.
 */
export function verifyConsoleMarker(
  raw: string | undefined,
  secret: string,
  nowMs: number,
): boolean {
  if (!raw || !secret) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [version, tsText, given] = parts;
  if (version !== CONSOLE_MARKER_VERSION) return false;
  if (!/^\d{1,12}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(given)) return false;

  const ts = Number(tsText);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > CONSOLE_MARKER_MAX_SKEW_S) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(given, 'hex'),
    Buffer.from(mac(secret, ts), 'hex'),
  );
}
