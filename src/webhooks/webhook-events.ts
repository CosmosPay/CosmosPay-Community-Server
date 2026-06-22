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
 */
export class WebhookEventPayload {
  constructor(
    readonly consumerUsername: string,
    readonly type: WebhookEventType,
    readonly data: unknown,
  ) {}
}
