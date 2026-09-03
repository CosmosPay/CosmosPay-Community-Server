import { Global, Module } from '@nestjs/common';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { StellarService } from '@/stellar/stellar.service';

@Global()
@Module({
  providers: [StellarService, StellarAccountLoader],
  exports: [StellarService, StellarAccountLoader],
})
export class StellarModule {}
