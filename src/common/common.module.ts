import { Global, Module } from '@nestjs/common';
import { AdvisoryLockService } from '@/common/services/advisory-lock.service';
import { PublicRecordTokens } from '@/common/public-record-token';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { RateLimitPruneService } from '@/common/services/rate-limit-prune.service';
import { RateLimitService } from '@/common/services/rate-limit.service';
import { RequestLogRetentionService } from '@/common/services/request-log-retention.service';

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
  providers: [
    RequestLogRetentionService,
    AdvisoryLockService,
    ConsumerResolverService,
    // The shared rate-limit counter, plus the job that clears rolled-over
    // windows. The guard that reads the counter is registered globally in
    // AppModule, which is why the service is exported.
    RateLimitService,
    RateLimitPruneService,
    // Per-record read tokens for what the shared public key creates: swaps,
    // cross-chain swaps and USDT0 transfers issue and check them.
    PublicRecordTokens,
  ],
  exports: [
    AdvisoryLockService,
    ConsumerResolverService,
    RateLimitService,
    PublicRecordTokens,
  ],
})
export class CommonModule {}
