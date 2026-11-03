import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminModule } from '@/admin/admin.module';
import type { AppConfig } from '@/config/configuration';
import { ProtectedPaymentsAdminService } from '@/native-plugins/trustless-work/admin/protected-payments-admin.service';
import { TrustlessWorkAdminController } from '@/native-plugins/trustless-work/admin/trustless-work-admin.controller';
import { ProtectedPaymentActionsService } from '@/native-plugins/trustless-work/protected-payment-actions.service';
import { ProtectedPaymentDeadlineService } from '@/native-plugins/trustless-work/protected-payment-deadline.service';
import { ProtectedPaymentExpiryService } from '@/native-plugins/trustless-work/protected-payment-expiry.service';
import { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import { ProtectedPaymentLinksController } from '@/native-plugins/trustless-work/protected-payment-links.controller';
import { ProtectedPaymentLinksService } from '@/native-plugins/trustless-work/protected-payment-links.service';
import { ProtectedPaymentSyncService } from '@/native-plugins/trustless-work/protected-payment-sync.service';
import { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import { ProtectedPaymentsController } from '@/native-plugins/trustless-work/protected-payments.controller';
import { ProtectedPaymentsService } from '@/native-plugins/trustless-work/protected-payments.service';
import { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import { assertTrustlessWorkConfigConsistent } from '@/native-plugins/trustless-work/trustless-work-config';
import { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

/**
 * The `trustless-work` native plugin: protected payments, held in Trustless
 * Work V1 single-release contracts on Stellar. Served only when
 * `PLUGINS_ENABLED` lists `trustless-work`, and it refuses to boot then with
 * keys that do not parse or that share an account. Owns the `protected_payment`
 * and `protected_payment_transaction` tables; imports the core AdminModule for
 * its guard, read-audit interceptor and audit trail.
 */
@Module({
  imports: [AdminModule],
  controllers: [
    ProtectedPaymentsController,
    ProtectedPaymentLinksController,
    TrustlessWorkAdminController,
  ],
  providers: [
    TrustlessWorkClient,
    TrustlessWorkKeys,
    ProtectedPaymentTransactionsService,
    ProtectedPaymentLifecycle,
    ProtectedPaymentActionsService,
    ProtectedPaymentsService,
    ProtectedPaymentLinksService,
    ProtectedPaymentsAdminService,
    ProtectedPaymentSyncService,
    ProtectedPaymentExpiryService,
    ProtectedPaymentDeadlineService,
  ],
})
export class TrustlessWorkModule {
  constructor(config: ConfigService<AppConfig, true>) {
    assertTrustlessWorkConfigConsistent(
      config.get('trustlessWork', { infer: true }),
    );
  }
}
