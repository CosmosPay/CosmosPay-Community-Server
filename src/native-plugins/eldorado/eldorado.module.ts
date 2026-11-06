import { Module } from '@nestjs/common';
import { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pOfframpController } from '@/native-plugins/eldorado/p2p-offramp.controller';
import { P2pOnrampController } from '@/native-plugins/eldorado/p2p-onramp.controller';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';

/**
 * The `eldorado` native plugin: stablecoins traded for local money with P2P
 * counterparts on El Dorado's marketplace, bought (`/v1/onramp/p2p`) and sold
 * (`/v1/offramp/p2p`). A third-party marketplace rather than the chain itself, so
 * it is served only when `PLUGINS_ENABLED` lists `eldorado`. Owns the
 * `p2p_ramp_session` table: the purchases and sales it opened for each consumer.
 */
@Module({
  controllers: [P2pOnrampController, P2pOfframpController],
  providers: [EldoradoClient, P2pRampService],
})
export class EldoradoModule {}
