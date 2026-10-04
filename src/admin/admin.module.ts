import { Module } from '@nestjs/common';
import { AdminAuditService } from '@/admin/admin-audit.service';
import { AdminController } from '@/admin/admin.controller';
import { AdminExtensions } from '@/admin/admin-extensions';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { AdminService } from '@/admin/admin.service';
import { AdminGuard } from '@/common/guards/admin.guard';

/**
 * The platform-admin surface over the core's own tables. It imports no feature
 * module: a native plugin that keeps rows of its own imports THIS module instead,
 * serves its admin routes behind the exported guard and read-audit interceptor,
 * and registers its section of the summary with {@link AdminExtensions}. The
 * dependency runs one way — the core never names a plugin.
 * AdminGuard is provided so Nest can instantiate it for @UseGuards.
 */
@Module({
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminAuditService,
    AdminExtensions,
    AdminGuard,
    AdminReadAuditInterceptor,
  ],
  exports: [
    AdminAuditService,
    AdminExtensions,
    AdminGuard,
    AdminReadAuditInterceptor,
  ],
})
export class AdminModule {}
