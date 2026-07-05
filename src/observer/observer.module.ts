import { Module } from '@nestjs/common';
import { LiquidityPoolsModule } from '../liquidity-pools/liquidity-pools.module';
import { SettlementObserverService } from './settlement-observer.service';

/**
 * Hosts the background settlement observer that reconciles swaps and liquidity
 * pool operations against Horizon. Prisma, Stellar and the event emitter are all
 * global; it imports LiquidityPoolsModule for the cost-basis capture hook.
 */
@Module({
  imports: [LiquidityPoolsModule],
  providers: [SettlementObserverService],
})
export class ObserverModule {}
