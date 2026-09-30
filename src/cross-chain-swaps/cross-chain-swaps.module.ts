import { Module } from '@nestjs/common';
import { CrossChainSwapObserverService } from '@/cross-chain-swaps/cross-chain-swap-observer.service';
import { CrossChainSwapsController } from '@/cross-chain-swaps/cross-chain-swaps.controller';
import { CrossChainSwapsService } from '@/cross-chain-swaps/cross-chain-swaps.service';
import { NearIntentsModule } from '@/near-intents/near-intents.module';

@Module({
  imports: [NearIntentsModule],
  controllers: [CrossChainSwapsController],
  providers: [CrossChainSwapsService, CrossChainSwapObserverService],
})
export class CrossChainSwapsModule {}
