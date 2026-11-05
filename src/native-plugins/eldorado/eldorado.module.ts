import { Module } from '@nestjs/common';
import { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pOnrampController } from '@/native-plugins/eldorado/p2p-onramp.controller';
import { P2pOnrampService } from '@/native-plugins/eldorado/p2p-onramp.service';

/**
 * The `eldorado` native plugin: stablecoins bought with local money from P2P
 * sellers on El Dorado's marketplace (`/v1/onramp/p2p`). A third-party
 * marketplace rather than the chain itself, so it is served only when
 * `PLUGINS_ENABLED` lists `eldorado`. Owns the `onramp_p2p_session` table: the
 * purchases it opened for each consumer.
 */
@Module({
  controllers: [P2pOnrampController],
  providers: [EldoradoClient, P2pOnrampService],
})
export class EldoradoModule {}
