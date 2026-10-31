import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import {
  EASY_RECOVERY_SWEEP_BATCH_SIZE,
  EASY_RECOVERY_SWEEP_MAX_PER_CYCLE,
} from '@/easy-recovery/easy-recovery.constants';

/**
 * Deletes easy recovery sessions past their five minutes.
 *
 * An expired session already answers 404 on every route, so this is not what
 * enforces the lifetime — the conditional writes are. It is what makes the
 * lifetime true of the TABLE: an offered session that nobody claimed still holds
 * a sealed wallet, and a claimed one is a tombstone kept only for the old
 * device's poll. Neither is read again once expired, so expiring them lazily
 * would mean keeping them forever.
 *
 * No grace window, unlike the sign-in sweeper: an expired session answers the
 * same 404 whether its row exists or not, so keeping it buys nothing.
 *
 * It runs on the wallet sign-in sweep's schedule (`WALLET_AUTH_SWEEP_ENABLED`,
 * `WALLET_AUTH_SWEEP_INTERVAL_MS`): the same deployment, the same kind of row,
 * and one switch for an operator to reason about.
 */
@Injectable()
export class EasyRecoverySweeperService extends ScheduledJob {
  protected readonly logger = new Logger(EasyRecoverySweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.EasyRecoverySweeper;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { sweep } = this.config.get('walletAuth', { infer: true });
    return {
      enabled: sweep.enabled,
      intervalMs: sweep.intervalMs,
      description: 'Easy recovery session sweeper',
    };
  }

  protected async run(): Promise<void> {
    const now = new Date();
    let examined = 0;
    let deleted = 0;

    // Page by page, so a backlog drains in short statements. Bounded by rows
    // examined, not deleted: a sibling replica that deleted the page first
    // returns a count of 0, and the loop must still end.
    while (examined < EASY_RECOVERY_SWEEP_MAX_PER_CYCLE) {
      const page = await this.prisma.easyRecoverySession.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take: EASY_RECOVERY_SWEEP_BATCH_SIZE,
      });
      if (page.length === 0) break;
      examined += page.length;

      const result = await this.prisma.easyRecoverySession.deleteMany({
        // Re-checked here as well as in the select: the delete never removes a
        // row on the strength of a read alone.
        where: {
          id: { in: page.map((row) => row.id) },
          expiresAt: { lt: now },
        },
      });
      deleted += result.count;

      if (page.length < EASY_RECOVERY_SWEEP_BATCH_SIZE) break;
    }

    if (deleted > 0) {
      this.logger.log(`Deleted ${deleted} expired easy recovery session(s)`);
    }
  }
}
