import { Module } from '@nestjs/common';
import { AssetsController } from '@/assets/assets.controller';
import { AssetsService } from '@/assets/assets.service';

@Module({
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
