import { Module } from '@nestjs/common';
import { DefindexController } from '@/native-plugins/defindex/defindex.controller';
import { DefindexService } from '@/native-plugins/defindex/defindex.service';

/**
 * The `defindex` native plugin: DeFindex vaults on Stellar. A third-party
 * protocol rather than the chain itself, so it is served only when
 * `PLUGINS_ENABLED` lists `defindex`.
 */
@Module({ controllers: [DefindexController], providers: [DefindexService] })
export class DefindexModule {}
