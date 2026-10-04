import { Module } from '@nestjs/common';
import { EvmModule } from '@/evm/evm.module';
import { JupiterModule } from '@/jupiter/jupiter.module';
import { KuruModule } from '@/kuru/kuru.module';
import { SolanaModule } from '@/solana/solana.module';
import { ChainSwapObserverService } from '@/swaps/chain-swap-observer.service';
import { ChainSwapsService } from '@/swaps/chain-swaps.service';
import { SwapsController } from '@/swaps/swaps.controller';
import { SwapsService } from '@/swaps/swaps.service';
import { MonadSwapVenue } from '@/swaps/venues/monad-swap.venue';
import { SolanaSwapVenue } from '@/swaps/venues/solana-swap.venue';

@Module({
  imports: [JupiterModule, KuruModule, SolanaModule, EvmModule],
  controllers: [SwapsController],
  providers: [
    SwapsService,
    ChainSwapsService,
    ChainSwapObserverService,
    SolanaSwapVenue,
    MonadSwapVenue,
  ],
  exports: [SwapsService],
})
export class SwapsModule {}
