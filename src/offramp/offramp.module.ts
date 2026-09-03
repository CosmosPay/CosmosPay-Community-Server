import { Module } from '@nestjs/common';
import { OfframpController } from '@/offramp/offramp.controller';
import { OfframpService } from '@/offramp/offramp.service';

/**
 * Offramp (stablecoin -> fiat): payout quotes, the on-chain authorize step for
 * non-EVM chains, payout creation, and compliance documents. Relies on the
 * global BlindpayModule for the HTTP client, consumer resolver, and sync service.
 */
@Module({
  controllers: [OfframpController],
  providers: [OfframpService],
})
export class OfframpModule {}
