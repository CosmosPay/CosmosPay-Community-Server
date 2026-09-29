import { Module } from '@nestjs/common';
import { ReceiversController } from '@/kyc/receivers/receivers.controller';
import { ReceiversService } from '@/kyc/receivers/receivers.service';
import { WalletsController } from '@/kyc/wallets/wallets.controller';
import { WalletsService } from '@/kyc/wallets/wallets.service';
import { BankAccountsController } from '@/kyc/bank-accounts/bank-accounts.controller';
import { BankAccountsService } from '@/kyc/bank-accounts/bank-accounts.service';
import { KycMetaController } from '@/kyc/upload/kyc-meta.controller';
import { KycMetaService } from '@/kyc/upload/kyc-meta.service';

/**
 * KYC/compliance surface: receivers (the KYC/KYB entities) and their blockchain
 * wallets and bank accounts, plus document upload and rail discovery. Exports
 * ReceiversService so the onramp module can resolve a receiver when creating
 * virtual accounts, and so the admin module can drive its audited `*ById` variants.
 * Relies on the global BlindpayModule for `BlindpayKycApi` (every BlindPay path this
 * module reaches) and the sync service.
 */
@Module({
  controllers: [
    ReceiversController,
    WalletsController,
    BankAccountsController,
    KycMetaController,
  ],
  providers: [
    ReceiversService,
    WalletsService,
    BankAccountsService,
    KycMetaService,
  ],
  exports: [ReceiversService],
})
export class KycModule {}
