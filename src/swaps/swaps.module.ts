import { Module } from '@nestjs/common';
import { SwapsController } from './swaps.controller';
import { SwapsService } from './swaps.service';

@Module({
  controllers: [SwapsController],
  providers: [SwapsService],
})
export class SwapsModule {}
