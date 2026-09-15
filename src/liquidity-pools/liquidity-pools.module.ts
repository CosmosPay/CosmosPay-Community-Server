import { Module } from '@nestjs/common';
import { LiquidityPoolReaderService } from '@/liquidity-pools/liquidity-pool-reader.service';
import { LiquidityPoolsController } from '@/liquidity-pools/liquidity-pools.controller';
import { LiquidityPoolsService } from '@/liquidity-pools/liquidity-pools.service';
import { LpCostBasisService } from '@/liquidity-pools/lp-cost-basis.service';

@Module({
  controllers: [LiquidityPoolsController],
  providers: [
    LiquidityPoolsService,
    LiquidityPoolReaderService,
    LpCostBasisService,
  ],
  // The settlement observer finalizes operations and backfills cost basis.
  exports: [LiquidityPoolsService, LpCostBasisService],
})
export class LiquidityPoolsModule {}
