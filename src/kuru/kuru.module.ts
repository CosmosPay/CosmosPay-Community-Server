import { Module } from '@nestjs/common';
import { KuruClient } from '@/kuru/kuru.client';

/** Kuru Flow's API, for same-chain Monad swaps. */
@Module({
  providers: [KuruClient],
  exports: [KuruClient],
})
export class KuruModule {}
