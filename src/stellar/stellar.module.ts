import { Global, Module } from '@nestjs/common';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { SignedTransactionRelay } from '@/stellar/signed-transaction-relay.service';
import { StellarService } from '@/stellar/stellar.service';

@Global()
@Module({
  providers: [StellarService, StellarAccountLoader, SignedTransactionRelay],
  exports: [StellarService, StellarAccountLoader, SignedTransactionRelay],
})
export class StellarModule {}
