import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { RATE_LIMIT_PRUNE_BATCH_SIZE } from '@/common/rate-limit.constants';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Deletes rate-limit windows that have rolled over.
 *
 * The table is append-mostly — one row per (policy, subject, window) — so
 * without this it grows for the life of the deployment with rows nothing will
 * ever read again. Nothing depends on the prune for *correctness*: an expired
 * window is already ignored, because the counter key includes the window start
 * and a new window is a new row.
 */
@Injectable()
export class RateLimitPruneService extends ScheduledJob {
  protected readonly logger = new Logger(RateLimitPruneService.name);
  protected readonly lockKey = AdvisoryLockKey.RateLimitPrune;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { enabled, pruneIntervalMs } = this.config.get('rateLimit', {
      infer: true,
    });
    return {
      // Nothing writes counters when the limiter is off, so there is nothing to
      // prune either.
      enabled,
      intervalMs: pruneIntervalMs,
      description: 'Rate limit counter prune',
    };
  }

  protected async run(): Promise<void> {
    // `deleteMany` takes no `take`, and the table's primary key is composite, so
    // the usual "select ids, then delete by id" shape does not apply. A bounded
    // `ctid` sub-select does the same job in one round trip: pick at most a
    // batch of physical rows past their deadline, delete exactly those.
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "rate_limit_counter"
      WHERE ctid IN (
        SELECT ctid FROM "rate_limit_counter"
        WHERE "expiresAt" < ${new Date()}
        ORDER BY "expiresAt" ASC
        LIMIT ${RATE_LIMIT_PRUNE_BATCH_SIZE}
      )
    `;
    if (deleted > 0) {
      this.logger.log(`Pruned ${deleted} expired rate limit counter(s)`);
    }
  }
}
