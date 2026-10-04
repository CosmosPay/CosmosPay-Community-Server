import { Module } from '@nestjs/common';
import { NearIntentsClient } from '@/near-intents/near-intents.client';

/** The NEAR Intents 1Click transport, for the modules that settle through it. */
@Module({
  providers: [NearIntentsClient],
  exports: [NearIntentsClient],
})
export class NearIntentsModule {}
