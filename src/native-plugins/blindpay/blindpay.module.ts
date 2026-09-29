import { Global, Module } from '@nestjs/common';
import { BlindpayClient } from '@/blindpay/blindpay.client';
import { BlindpayKycApi } from '@/blindpay/blindpay-kyc.api';
import { BlindpayOfframpApi } from '@/blindpay/blindpay-offramp.api';
import { BlindpayOnrampApi } from '@/blindpay/blindpay-onramp.api';
import { BlindpaySyncService } from '@/blindpay/blindpay-sync.service';
import { BlindpayWebhooksController } from '@/blindpay/webhooks/blindpay-webhooks.controller';

/**
 * Core of the BlindPay integration. Global so the KYC/onramp/offramp feature
 * modules can inject their provider API surface and the sync service without
 * importing this module everywhere. (The consumer resolver moved to
 * CommonModule — every tenant-scoped service needs it, not just these.) Also hosts the inbound
 * webhook endpoint.
 *
 * Feature services inject the `Blindpay*Api` surface for their area, not the raw
 * client: the provider's URL layout is this module's knowledge. `BlindpayClient`
 * stays exported because it is the transport those surfaces wrap, and the e2e
 * suites override it to keep BlindPay off the network.
 */
@Global()
@Module({
  controllers: [BlindpayWebhooksController],
  providers: [
    BlindpayClient,
    BlindpayKycApi,
    BlindpayOnrampApi,
    BlindpayOfframpApi,
    BlindpaySyncService,
  ],
  exports: [
    BlindpayClient,
    BlindpayKycApi,
    BlindpayOnrampApi,
    BlindpayOfframpApi,
    BlindpaySyncService,
  ],
})
export class BlindpayModule {}
