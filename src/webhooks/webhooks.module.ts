import { Global, Module } from '@nestjs/common';
import { WebhooksController } from '@/webhooks/webhooks.controller';
import { WebhooksService } from '@/webhooks/webhooks.service';
import { WebhookDispatcherService } from '@/webhooks/webhook-dispatcher.service';
import { WebhookDestinationGuard } from '@/webhooks/webhook-destination.guard';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { WebhookDeliverySweeperService } from '@/webhooks/webhook-delivery-sweeper.service';
import { WebhookHttpClient } from '@/webhooks/webhook-http';

@Global()
@Module({
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookDispatcherService,
    WebhookDestinationGuard,
    WebhookTerminalEmitter,
    // Background recovery for deliveries the in-process retry loop dropped.
    WebhookDeliverySweeperService,
    // Outbound HTTP as a provider: the seam tests replace instead of the
    // network (see WebhookHttpClient).
    WebhookHttpClient,
  ],
  // Terminal emitter is the single claim+emit path for observer and submit.
  exports: [
    WebhookDispatcherService,
    WebhookTerminalEmitter,
    WebhookHttpClient,
  ],
})
export class WebhooksModule {}
