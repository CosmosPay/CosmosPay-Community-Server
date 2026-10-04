import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  isPluginEventType,
  PluginRuntimeService,
} from '@/plugins/plugin-runtime.service';
import { WEBHOOK_EVENT, WebhookEventPayload } from '@/webhooks/webhook-events';

/**
 * Hands core events to the plugins that subscribe to them.
 *
 * It listens on the same internal bus the webhook dispatcher does, beside it
 * rather than in front of it: a plugin that is slow or throws cannot delay or
 * suppress an integrator's webhook, because the two listeners do not wait on
 * each other. Only the event types the SDK publishes get through.
 */
@Injectable()
export class PluginEventBridge {
  private readonly logger = new Logger(PluginEventBridge.name);

  constructor(private readonly runtime: PluginRuntimeService) {}

  @OnEvent(WEBHOOK_EVENT, { async: true, promisify: true })
  async handle(payload: WebhookEventPayload): Promise<void> {
    if (!isPluginEventType(payload.type)) return;
    try {
      await this.runtime.dispatchEvent(
        payload.consumerUsername,
        payload.type,
        payload.data,
      );
    } catch (err) {
      // `dispatchEvent` swallows plugin failures; this is the lookup failing.
      this.logger.error(
        `Plugin delivery of ${payload.type} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
