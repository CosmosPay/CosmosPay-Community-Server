import { Global, Module } from '@nestjs/common';
import { BlindpayClient } from './blindpay.client';
import { ConsumerResolverService } from './consumer-resolver.service';
import { BlindpaySyncService } from './blindpay-sync.service';
import { BlindpayWebhooksController } from './webhooks/blindpay-webhooks.controller';

/**
 * Core of the BlindPay integration. Global so the KYC/onramp/offramp feature
 * modules can inject the shared HTTP client, the consumer resolver, and the sync
 * service without importing this module everywhere. Also hosts the inbound
 * webhook endpoint.
 */
@Global()
@Module({
  controllers: [BlindpayWebhooksController],
  providers: [BlindpayClient, ConsumerResolverService, BlindpaySyncService],
  exports: [BlindpayClient, ConsumerResolverService, BlindpaySyncService],
})
export class BlindpayModule {}
