import type { Prisma } from '@generated/prisma/client';

/**
 * What replaces a delivery body once it is past retention.
 *
 * A delivery body is the event exactly as signed and sent. For
 * `RECEIVER_UPDATED` that body is the provider's full KYC dossier, so it is not
 * kept forever — but `payload` is a non-nullable Json column and the delivery
 * row itself is the audit trail, so the body is overwritten with this marker
 * rather than the row being deleted.
 *
 * This lives in the webhooks module, not in the retention service that writes
 * it, because *every* path that re-sends a stored body has to agree on it. The
 * marker is simultaneously three things:
 *
 *   1. the tombstone the retention prune writes;
 *   2. the predicate that keeps the prune from re-clearing a cleared row, so
 *      its loop terminates;
 *   3. the thing the sweeper and the redelivery route must refuse to send.
 *
 * (3) is the one that bites. A tombstoned row is still `FAILED` and still
 * inside the sweeper's attempt budget, and the sweeper has no upper age bound —
 * so a delivery whose endpoint was blocked for longer than the retention window
 * and then re-enabled would be picked up, `JSON.stringify`d, signed with a
 * valid `X-Cosmos-Signature` and POSTed to the integrator as
 * `{"redacted":true}` under a real event type. A correctly-implemented receiver
 * would accept it: the signature verifies. Hence {@link EXCLUDE_REDACTED}.
 */
export const REDACTED_PAYLOAD = { redacted: true } as const;

/**
 * Prisma predicate excluding deliveries whose body has been cleared.
 *
 * Add this to any query that will re-send `payload`. `equals` is exact JSON
 * equality, so a real body that merely happens to contain `redacted: true`
 * among other keys is not excluded.
 */
export const EXCLUDE_REDACTED = {
  NOT: { payload: { equals: REDACTED_PAYLOAD } },
} as const satisfies Prisma.WebhookDeliveryWhereInput;

/** True when this delivery's body has been cleared and can no longer be sent. */
export function isRedactedPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const keys = Object.keys(payload);
  return (
    keys.length === 1 &&
    keys[0] === 'redacted' &&
    (payload as { redacted: unknown }).redacted === true
  );
}
