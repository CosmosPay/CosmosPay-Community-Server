import { Module } from '@nestjs/common';
import { KycModule } from '@/native-plugins/blindpay/kyc/kyc.module';
import { OnrampController } from '@/native-plugins/blindpay/onramp/onramp.controller';
import { OnrampService } from '@/native-plugins/blindpay/onramp/onramp.service';
import { VirtualAccountsController } from '@/native-plugins/blindpay/onramp/virtual-accounts/virtual-accounts.controller';
import { VirtualAccountsService } from '@/native-plugins/blindpay/onramp/virtual-accounts/virtual-accounts.service';

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
