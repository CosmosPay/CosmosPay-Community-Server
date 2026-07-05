import { Module } from '@nestjs/common';
import { SettlementObserverService } from './settlement-observer.service';

/**
 * Hosts the background settlement observer that reconciles swaps and liquidity
 * pool operations against Horizon. Prisma, Stellar and the event emitter are all
 * global, so the module only needs to register the service.
 */
@Module({
  providers: [SettlementObserverService],
})
export class ObserverModule {}
