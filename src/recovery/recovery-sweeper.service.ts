import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecoveryEmailCodeStatus } from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import {
  RECOVERY_SWEEP_BATCH_SIZE,
  RECOVERY_SWEEP_GRACE_MS,
} from '@/recovery/recovery.constants';

/**
 * Retires recovery codes nobody answered, and forgets ID tokens that can no
 * longer be presented.
 *
 * An expired PENDING code keeps its hash until this runs, and a hash with nothing
 * checking the clock is a guessable credential — so the first job clears it. The
 * spent-token records only have to outlive the token they stand for: after its
 * own `exp` no provider-signed token verifies anyway. Runs under an advisory lock,
 * so replicas behind a load balancer take turns rather than racing.
 *
 * Idle on a deployment that is not a recovery server.
 */
@Injectable()
export class RecoverySweeperService extends ScheduledJob {
  protected readonly logger = new Logger(RecoverySweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.RecoverySweeper;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { sweep, role } = this.config.get('recovery', { infer: true });
    return {
      enabled: sweep.enabled && role !== null,
      intervalMs: sweep.intervalMs,
      description: 'Recovery code and spent-token sweeper',
    };
  }

  protected async run(): Promise<void> {
    const now = new Date();

    const stale = await this.prisma.recoveryEmailCode.findMany({
      where: {
        status: RecoveryEmailCodeStatus.PENDING,
        expiresAt: { lt: now },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: RECOVERY_SWEEP_BATCH_SIZE,
    });
    if (stale.length) {
      const expired = await this.prisma.recoveryEmailCode.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: { status: RecoveryEmailCodeStatus.EXPIRED, codeHash: '' },
      });
      this.logger.log(`Expired ${expired.count} recovery code(s)`);
    }

    const cutoff = new Date(now.getTime() - RECOVERY_SWEEP_GRACE_MS);
    const codes = await this.prisma.recoveryEmailCode.deleteMany({
      where: {
        status: { not: RecoveryEmailCodeStatus.PENDING },
        expiresAt: { lt: cutoff },
      },
    });
    const tokens = await this.prisma.recoveryUsedIdToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const total = codes.count + tokens.count;
    if (total > 0) this.logger.log(`Deleted ${total} spent recovery row(s)`);
  }
}
