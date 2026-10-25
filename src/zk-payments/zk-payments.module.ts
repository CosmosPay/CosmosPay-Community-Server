import { Module } from '@nestjs/common';
import { ConfidentialSdk } from '@/zk-payments/confidential-sdk';
import { ZkCheckoutController } from '@/zk-payments/zk-checkout.controller';
import { ZkCheckoutService } from '@/zk-payments/zk-checkout.service';
import { ZkNetworksService } from '@/zk-payments/zk-networks.service';
import { ZkPaymentsController } from '@/zk-payments/zk-payments.controller';
import { ZkPaymentsService } from '@/zk-payments/zk-payments.service';

/**
 * ZK payments: confidential payments on Cosmos Pay's token, amount hidden
 * on-chain, 0.01% commission. The merchant's routes under `/v1/zk-payments`,
 * the payer's keyless ones under `/v1/zk-checkout`. The confidential token SDK
 * is reached only through {@link ConfidentialSdk}.
 *
 * `WebhookTerminalEmitter` and `ConsumerResolverService` come from the global
 * webhooks and common modules.
 */
@Module({
  controllers: [ZkPaymentsController, ZkCheckoutController],
  providers: [
    ZkPaymentsService,
    ZkCheckoutService,
    ZkNetworksService,
    ConfidentialSdk,
  ],
})
export class ZkPaymentsModule {}
