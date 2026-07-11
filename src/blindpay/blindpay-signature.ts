import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The Svix webhook headers BlindPay sends with every delivery.
 */
export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const WHSEC_PREFIX = 'whsec_';

/**
 * Verifies a BlindPay (Svix) webhook signature.
 *
 * Svix signs the content `${svix-id}.${svix-timestamp}.${rawBody}` with
 * HMAC-SHA256 using the endpoint secret — a `whsec_`-prefixed base64 string whose
 * decoded bytes are the HMAC key. The `svix-signature` header is a space-delimited
 * list of `v<version>,<base64sig>` tokens; the payload is authentic when any `v1`
 * signature matches ours. The timestamp must be recent to blunt replay attacks.
 *
 * Comparison is constant-time. Returns false on any missing/garbled input rather
 * than throwing, so callers can map a single 400 for all rejection reasons.
 */
export function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: SvixHeaders,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (
    !secret ||
    !rawBody ||
    !headers.id ||
    !headers.timestamp ||
    !headers.signature
  ) {
    return false;
  }

  if (!isTimestampValid(headers.timestamp, toleranceSeconds)) {
    return false;
  }

  const expected = Buffer.from(
    computeSvixSignature(secret, headers.id, headers.timestamp, rawBody),
  );

  // Header form: "v1,<sig> v1,<sig2> v2,<sig3>" — accept if any v1 sig matches.
  for (const token of headers.signature.split(' ')) {
    const commaAt = token.indexOf(',');
    if (commaAt === -1) continue;
    const version = token.slice(0, commaAt);
    const value = token.slice(commaAt + 1);
    if (version !== 'v1' || !value) continue;

    const candidate = Buffer.from(value);
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Computes the base64 HMAC-SHA256 signature Svix expects for a delivery.
 * Exposed for tests and for signing simulated deliveries.
 */
export function computeSvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): string {
  const key = secret.startsWith(WHSEC_PREFIX)
    ? Buffer.from(secret.slice(WHSEC_PREFIX.length), 'base64')
    : Buffer.from(secret, 'base64');

  return createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
}

function isTimestampValid(
  timestamp: string,
  toleranceSeconds: number,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= toleranceSeconds;
}
