import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Imports KycModule so the admin (owner) endpoints can reuse ReceiversService's
 * approve/enable logic across ANY consumer (the global fiat review tools).
 */
@Module({
  imports: [KycModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
