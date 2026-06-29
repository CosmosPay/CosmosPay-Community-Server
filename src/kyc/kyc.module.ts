import { Module } from '@nestjs/common';
import { ReceiversController } from './receivers/receivers.controller';
import { ReceiversService } from './receivers/receivers.service';
import { WalletsController } from './wallets/wallets.controller';
import { WalletsService } from './wallets/wallets.service';
import { BankAccountsController } from './bank-accounts/bank-accounts.controller';
import { BankAccountsService } from './bank-accounts/bank-accounts.service';
import { KycMetaController } from './upload/kyc-meta.controller';
import { KycMetaService } from './upload/kyc-meta.service';

/**
 * KYC/compliance surface: receivers (the KYC/KYB entities) and their blockchain
 * wallets and bank accounts, plus document upload and rail discovery. Exports
 * ReceiversService so the onramp module can resolve a receiver when creating
 * virtual accounts. Relies on the global BlindpayModule for the HTTP client,
 * consumer resolver, and sync service.
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
