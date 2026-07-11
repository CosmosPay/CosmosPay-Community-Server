import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { OnrampController } from './onramp.controller';
import { OnrampService } from './onramp.service';
import { VirtualAccountsController } from './virtual-accounts/virtual-accounts.controller';
import { VirtualAccountsService } from './virtual-accounts/virtual-accounts.service';

/**
 * Onramp (fiat -> stablecoin): payin quotes, payins, virtual accounts, and the
 * Stellar trustline helper. Imports KycModule to resolve receivers when creating
 * virtual accounts.
 */
@Module({
  imports: [KycModule],
  controllers: [OnrampController, VirtualAccountsController],
  providers: [OnrampService, VirtualAccountsService],
})
export class OnrampModule {}
