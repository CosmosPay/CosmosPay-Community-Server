import { Module } from '@nestjs/common';
import { JupiterClient } from '@/jupiter/jupiter.client';

/** Jupiter's Swap API, for same-chain Solana swaps. */
@Module({
  providers: [JupiterClient],
  exports: [JupiterClient],
})
export class JupiterModule {}
