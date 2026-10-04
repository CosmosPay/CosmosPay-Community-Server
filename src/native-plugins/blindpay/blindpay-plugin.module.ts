import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import { BlindpayAdminModule } from '@/native-plugins/blindpay/admin/blindpay-admin.module';
import { assertBlindpayInstancesConsistent } from '@/native-plugins/blindpay/blindpay-config';
import { BlindpayModule } from '@/native-plugins/blindpay/blindpay.module';
import { KycModule } from '@/native-plugins/blindpay/kyc/kyc.module';
import { OfframpModule } from '@/native-plugins/blindpay/offramp/offramp.module';
import { OnrampModule } from '@/native-plugins/blindpay/onramp/onramp.module';

/**
 * The `blindpay` native plugin: fiat on/off-ramp and KYC through BlindPay.
 *
 * BlindpayModule is global and hosts the shared client, the sync service and
 * the inbound webhook endpoint; the feature modules use it. OnrampModule imports
 * KycModule (receiver resolution), and BlindpayAdminModule adds the plugin's
 * routes under `/v1/admin` and its section of the admin summary.
 *
 * Instantiated only when `PLUGINS_ENABLED` lists `blindpay`, and it refuses to
 * boot then if either instance's variables are half set.
 */
@Module({
  imports: [
    BlindpayModule,
    KycModule,
    OnrampModule,
    OfframpModule,
    BlindpayAdminModule,
  ],
})
export class BlindpayPluginModule {
  constructor(config: ConfigService<AppConfig, true>) {
    assertBlindpayInstancesConsistent(config.get('blindpay', { infer: true }));
  }
}
