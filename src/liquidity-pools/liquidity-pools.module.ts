import { Module } from '@nestjs/common';
import { LiquidityPoolsController } from './liquidity-pools.controller';
import { LiquidityPoolsService } from './liquidity-pools.service';

@Module({
  controllers: [LiquidityPoolsController],
  providers: [LiquidityPoolsService],
})
export class LiquidityPoolsModule {}
