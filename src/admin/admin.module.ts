import { Module } from '@nestjs/common';
import { KycModule } from '@/kyc/kyc.module';
import { AdminAuditService } from '@/admin/admin-audit.service';
import { AdminController } from '@/admin/admin.controller';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { AdminService } from '@/admin/admin.service';
import { AdminGuard } from '@/common/guards/admin.guard';

/**
 * Imports KycModule so the admin (owner) endpoints can reuse ReceiversService's
 * approve/enable/requestTos/setAccess logic across ANY consumer (the global fiat review
 * tools). The dependency runs one way: kyc never imports admin — the audit rows both
 * write go through `@/audit/audit-writer`, which imports neither.
 * AdminGuard is provided so Nest can instantiate it for @UseGuards.
 */
@Module({
  imports: [KycModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminAuditService,
    AdminGuard,
    AdminReadAuditInterceptor,
  ],
})
export class AdminModule {}
