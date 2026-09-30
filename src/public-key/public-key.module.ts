import { Module } from '@nestjs/common';
import { PublicKeyController } from '@/public-key/public-key.controller';
import { PublicKeyService } from '@/public-key/public-key.service';

@Module({
  controllers: [PublicKeyController],
  providers: [PublicKeyService],
})
export class PublicKeyModule {}
