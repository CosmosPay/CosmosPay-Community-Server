import { Module } from '@nestjs/common';
import { SwapsController } from '@/swaps/swaps.controller';
import { SwapsService } from '@/swaps/swaps.service';

@Module({
  controllers: [SwapsController],
  providers: [SwapsService],
  exports: [SwapsService],
})
export class SwapsModule {}
