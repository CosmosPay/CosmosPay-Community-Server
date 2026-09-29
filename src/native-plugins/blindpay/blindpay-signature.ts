import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The Svix webhook headers BlindPay sends with every delivery.
 */
export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

import {
  SVIX_MIN_SECRET_BYTES,
  SVIX_SECRET_PREFIX,
  SVIX_TOLERANCE_SECONDS,
} from '@/blindpay/blindpay.constants';

/** Standard base64 — the alphabet Svix encodes the key in after its prefix. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The HMAC key inside a Svix endpoint secret, or null when the value is not a
 * well-formed base64 key of at least {@link SVIX_MIN_SECRET_BYTES}.
 *
 * `Buffer.from(value, 'base64')` never fails: it skips every character outside
 * the alphabet, so a mistyped secret decodes to a short or empty key and each
 * signature computed from it is one anybody can compute. Env validation refuses
 * such a value at boot, and verification refuses to run with one regardless.
 */
export function decodeSvixSecret(secret: string): Buffer | null {
  const encoded = secret.startsWith(SVIX_SECRET_PREFIX)
    ? secret.slice(SVIX_SECRET_PREFIX.length)
    : secret;
  if (!BASE64_RE.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length >= SVIX_MIN_SECRET_BYTES ? key : null;
}

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
  toleranceSeconds: number = SVIX_TOLERANCE_SECONDS,
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

  // Fail closed on a key nobody should trust, even if it slipped past boot
  // validation: a signature made with it proves nothing.
  if (!decodeSvixSecret(secret)) {
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
  const key = secret.startsWith(SVIX_SECRET_PREFIX)
    ? Buffer.from(secret.slice(SVIX_SECRET_PREFIX.length), 'base64')
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
