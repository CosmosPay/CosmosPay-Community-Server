import { WebhookEventType } from '../../generated/prisma/client';

/**
 * Internal event name used with EventEmitter2. The webhook dispatcher listens
 * with the `webhook.*` wildcard so any domain module can fire notifications
 * without depending on the webhooks module directly.
 */
export const WEBHOOK_EVENT = 'webhook.event';

/**
 * Payload emitted on the internal bus. `consumerUsername` scopes delivery to the
 * integrator (APISIX consumer) that owns the affected resource.
 *
 * Integrator-facing webhook bodies stay `{ id, type, createdAt, data }` — this
 * class is the internal envelope, not the HTTP JSON.
 */
export class WebhookEventPayload {
  constructor(
    readonly consumerUsername: string,
    readonly type: WebhookEventType,
    readonly data: unknown,
    /**
     * Ids of the `webhook_delivery` rows already committed for this event.
     *
     * Set when the emitter persisted the work in the same transaction as its
     * dedup claim — the dispatcher must then send exactly those rows and must
     * not create more, or an event recovered after a crash would go out twice.
     * Absent for events published straight onto the bus, which the dispatcher
     * persists itself before its first attempt.
     */
    readonly deliveryIds?: readonly string[],
  ) {}
}

/**
 * Settlement events that must survive a crash: the emitter claims a unique
 * `(eventType, resourceId, settlementEpoch)` row and writes the delivery rows in
 * the same transaction, so the notification is durable work on disk before it
 * ever reaches the in-memory bus.
 *
 * Two distinct reasons land an event here:
 *
 *  - **Dedup.** Swaps and liquidity operations have two writers — the settlement
 *    observer and `submit` — that can both finalize the same row, so the claim is
 *    what makes the pair produce one notification instead of two with different
 *    `evt_` ids. Epoch advances on a FAILED → SUBMITTED resubmit, so a later
 *    failure is a new event rather than a suppressed duplicate.
 *  - **Durability.** Payment intents have a single writer already: the status
 *    change is a transactional compare-and-swap and only the winner emits, and
 *    SUCCEEDED/FAILED are absorbing states in the intent graph, so the claim is
 *    redundant for them (epoch is always 0 — there is only ever one settlement
 *    attempt). They are listed anyway for the delivery rows, without which a pod
 *    killed between "settled" and "notified" lost the notification for good.
 */
export const TERMINAL_WEBHOOK_EVENTS = [
  'SWAP_SUCCEEDED',
  'SWAP_FAILED',
  'LIQUIDITY_SUCCEEDED',
  'LIQUIDITY_FAILED',
  'PAYMENT_INTENT_SUCCEEDED',
  'PAYMENT_INTENT_FAILED',
] as const satisfies readonly WebhookEventType[];

export type TerminalWebhookEventType = (typeof TERMINAL_WEBHOOK_EVENTS)[number];

export function isTerminalWebhookEvent(
  type: WebhookEventType,
): type is TerminalWebhookEventType {
  return (TERMINAL_WEBHOOK_EVENTS as readonly WebhookEventType[]).includes(
    type,
  );
}

/** Stable uniqueness key: one row per operation, event type, and attempt. */
export function terminalEventDedupKey(
  type: WebhookEventType,
  resourceId: string,
  settlementEpoch = 0,
): string {
  return `${type}:${resourceId}:${settlementEpoch}`;
}
