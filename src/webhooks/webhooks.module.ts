import { Global, Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { WebhookTerminalEmitter } from './webhook-terminal-emitter.service';
import { WebhookDeliverySweeperService } from './webhook-delivery-sweeper.service';
import { WebhookHttpClient } from './webhook-http';

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
