import { Module } from '@nestjs/common';
import { AdminModule } from '@/admin/admin.module';
import { BlindpayAdminController } from '@/native-plugins/blindpay/admin/blindpay-admin.controller';
import { BlindpayAdminService } from '@/native-plugins/blindpay/admin/blindpay-admin.service';
import { KycModule } from '@/native-plugins/blindpay/kyc/kyc.module';

/**
 * BlindPay's platform-admin routes. Imports the core AdminModule for its guard,
 * read-audit interceptor and extension registry, and KycModule for the audited
 * `*ById` receiver actions.
 */
@Module({
  imports: [AdminModule, KycModule],
  controllers: [BlindpayAdminController],
  providers: [BlindpayAdminService],
})
export class BlindpayAdminModule {}
