import { Global, Module } from '@nestjs/common';
import { StellarAccountLoader } from './account-loader.service';
import { StellarService } from './stellar.service';

@Global()
@Module({
  providers: [StellarService, StellarAccountLoader],
  exports: [StellarService, StellarAccountLoader],
})
export class StellarModule {}
