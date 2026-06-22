import { createHmac } from 'node:crypto';

/**
 * Stripe-style signature over `${timestamp}.${body}` with the endpoint secret.
 * Integrators recompute this and constant-time compare against the
 * `X-Cosmos-Signature` header to authenticate the payload.
 *
 *   header value: `t=<unixSeconds>,v1=<hexHmacSha256>`
 */
export function buildSignatureHeader(
  secret: string,
  body: string,
  timestampSeconds: number,
): string {
  const signature = signPayload(secret, body, timestampSeconds);
  return `t=${timestampSeconds},v1=${signature}`;
}

export function signPayload(
  secret: string,
  body: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.${body}`)
    .digest('hex');
}
