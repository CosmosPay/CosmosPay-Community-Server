import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import { BankIncomeService } from '@/native-plugins/koywe/bank-income.service';
import { BankTransferConversion } from '@/native-plugins/koywe/bank-transfer-conversion.service';
import { BankTransferLinksController } from '@/native-plugins/koywe/bank-transfer-links.controller';
import { BankTransferOrders } from '@/native-plugins/koywe/bank-transfer-orders.service';
import { BankTransferRail } from '@/native-plugins/koywe/bank-transfer-rail.service';
import { BankTransferSweepService } from '@/native-plugins/koywe/bank-transfer-sweep.service';
import { BankTransferWebhooksController } from '@/native-plugins/koywe/bank-transfer-webhooks.controller';
import { BankTransferWebhooks } from '@/native-plugins/koywe/bank-transfer-webhooks.service';
import { BankTransfersService } from '@/native-plugins/koywe/bank-transfers.service';
import { assertKoyweConfigConsistent } from '@/native-plugins/koywe/koywe-config';
import { KoyweCryptoAccounts } from '@/native-plugins/koywe/koywe-crypto-accounts.service';
import { KoywePooledAccount } from '@/native-plugins/koywe/koywe-pooled-account.service';
import { KoyweVirtualAccounts } from '@/native-plugins/koywe/koywe-virtual-accounts.service';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import { TransferAccountsController } from '@/native-plugins/koywe/transfer-accounts.controller';
import { TransferAccountsService } from '@/native-plugins/koywe/transfer-accounts.service';
import { PaymentRequestRailsModule } from '@/payment-request-rails/payment-request-rails.module';

/**
 * The `koywe` native plugin: payment requests (charges in local money shown
 * as a QR, owned by the `eldorado` plugin) paid by bank transfer in ARS. Each
 * seller opens an account of their own at the provider (a merchant under
 * Cosmos Pay's organization, verified by the provider's hosted KYB, with an
 * ARS CVU in their name: `/v1/onramp/transfer/account`); the payer asks for the
 * deposit instructions (`/v1/payment-links/fiat/{id}/transfers`), transfers
 * from an account in their own name, and the provider's webhook
 * (`/v1/onramp/transfer/webhooks`) reports the deposit, which is converted to
 * the request's token and delivered to the seller's address.
 *
 * Served only when `PLUGINS_ENABLED` lists `koywe` (and `eldorado`, which it
 * refuses to boot without). It reaches payment requests only through the core's
 * `PaymentRequestRails`, where it registers the `transfer` rail. Owns
 * `bank_transfer_account`, `bank_transfer`, `bank_transfer_webhook_event`,
 * `bank_income_event` and `bank_transfer_crypto_account`.
 */
@Module({
  imports: [PaymentRequestRailsModule],
  controllers: [
    TransferAccountsController,
    BankTransferLinksController,
    BankTransferWebhooksController,
  ],
  providers: [
    KoyweClient,
    KoyweVirtualAccounts,
    KoywePooledAccount,
    KoyweCryptoAccounts,
    TransferAccountsService,
    BankTransferRail,
    BankTransfersService,
    BankIncomeService,
    BankTransferOrders,
    BankTransferConversion,
    BankTransferWebhooks,
    BankTransferSweepService,
  ],
})
export class KoyweModule {
  constructor(config: ConfigService<AppConfig, true>) {
    const notes = assertKoyweConfigConsistent(
      config.get('koywe', { infer: true }),
      config.get('plugins.native', { infer: true }),
    );
    const logger = new Logger(KoyweModule.name);
    for (const note of notes) logger.warn(note);
  }
}
