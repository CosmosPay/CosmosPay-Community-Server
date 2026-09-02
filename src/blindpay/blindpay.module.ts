import { Global, Module } from '@nestjs/common';
import { BlindpayClient } from '@/blindpay/blindpay.client';
import { BlindpaySyncService } from '@/blindpay/blindpay-sync.service';
import { BlindpayWebhooksController } from '@/blindpay/webhooks/blindpay-webhooks.controller';

/**
 * Core of the BlindPay integration. Global so the KYC/onramp/offramp feature
 * modules can inject the shared HTTP client and the sync service without
 * importing this module everywhere. (The consumer resolver moved to
 * CommonModule — every tenant-scoped service needs it, not just these.) Also hosts the inbound
 * webhook endpoint.
 */
@Global()
@Module({
  controllers: [BlindpayWebhooksController],
  providers: [BlindpayClient, BlindpaySyncService],
  exports: [BlindpayClient, BlindpaySyncService],
})
export class BlindpayModule {}
