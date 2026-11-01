import { Module } from '@nestjs/common';
import { DefindexClient } from '@/native-plugins/defindex/defindex.client';
import { DefindexController } from '@/native-plugins/defindex/defindex.controller';
import { DefindexService } from '@/native-plugins/defindex/defindex.service';
import { DefindexTransactionsService } from '@/native-plugins/defindex/defindex-transactions.service';

/**
 * The `defindex` native plugin: DeFindex vaults on Stellar. A third-party
 * protocol rather than the chain itself, so it is served only when
 * `PLUGINS_ENABLED` lists `defindex`. Owns the `defindex_transaction` table:
 * what its builds handed out, which is all its submit will relay.
 */
@Module({
  controllers: [DefindexController],
  providers: [DefindexClient, DefindexService, DefindexTransactionsService],
})
export class DefindexModule {}
