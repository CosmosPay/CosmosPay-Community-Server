import { Global, Module } from '@nestjs/common';
import { AdvisoryLockService } from './services/advisory-lock.service';
import { RequestLogRetentionService } from './services/request-log-retention.service';

/**
 * Hosts background jobs that belong to common infra (not a domain module), plus
 * the cluster-wide advisory lock every one of those jobs needs.
 *
 * Global because the lock is used by timers that live in other feature modules
 * (the settlement observer, the payment-intent observer); making it global
 * avoids threading a `CommonModule` import through each of them.
 * PrismaService and ConfigService are global for the same reason.
 */
@Global()
@Module({
  providers: [RequestLogRetentionService, AdvisoryLockService],
  exports: [AdvisoryLockService],
})
export class CommonModule {}
