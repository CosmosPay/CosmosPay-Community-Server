import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import {
  ALIAS_SWEEP_BATCH_SIZE,
  ALIAS_SWEEP_GRACE_MS,
  ALIAS_SWEEP_INTERVAL_MS,
  ALIAS_SWEEP_MAX_PER_CYCLE,
} from '@/aliases/aliases.constants';

/**
 * Deletes alias challenges and recoveries that can no longer be spent.
 *
 * Both tables grow on requests that leave the caller nothing to keep: any
 * `payments:write` key can mint a challenge, and every recovery start writes a
 * row. Past `expiresAt` a row is dead weight — `spendChallenge` and
 * `completeRecovery` already refuse it — and an expired recovery still carries
 * the owner's mailbox. Nothing ever deleted them, so they accumulated for as long
 * as someone kept asking.
 *
 * Its own job rather than a fourth prune inside `RequestLogRetentionService`:
 * that one enforces a retention policy an operator configures, this one removes
 * rows that stopped meaning anything, and the two change for different reasons.
 */
@Injectable()
export class AliasChallengeSweeperService extends ScheduledJob {
  protected readonly logger = new Logger(AliasChallengeSweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.AliasChallengeSweeper;

  constructor(
    private readonly prisma: PrismaService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    return {
      enabled: true,
      intervalMs: ALIAS_SWEEP_INTERVAL_MS,
      description: 'Alias challenge/recovery sweep',
    };
  }

  protected async run(): Promise<void> {
    const cutoff = new Date(Date.now() - ALIAS_SWEEP_GRACE_MS);
    const where = { expiresAt: { lt: cutoff } };

    // Two calls rather than one generic over a delegate: Prisma's delegates are
    // not interchangeable values, and a helper typed over both would be `any`.
    const challenges = await this.drain(
      (take) =>
        this.prisma.aliasChallenge.findMany({
          where,
          select: { id: true },
          orderBy: { expiresAt: 'asc' },
          take,
        }),
      (ids) =>
        this.prisma.aliasChallenge.deleteMany({ where: { id: { in: ids } } }),
    );
    const recoveries = await this.drain(
      (take) =>
        this.prisma.aliasRecovery.findMany({
          where,
          select: { id: true },
          orderBy: { expiresAt: 'asc' },
          take,
        }),
      (ids) =>
        this.prisma.aliasRecovery.deleteMany({ where: { id: { in: ids } } }),
    );

    if (challenges + recoveries > 0) {
      this.logger.log(
        `Swept ${challenges} alias challenge(s) and ${recoveries} recovery row(s) that expired before ${cutoff.toISOString()}`,
      );
    }
  }

  /**
   * Select a bounded page of ids, delete exactly those, repeat.
   *
   * `deleteMany` takes no `take`, so an unbounded delete would lock every expired
   * row in one statement. The loop is capped by rows EXAMINED, not deleted: a
   * replica racing a sibling can see `count: 0` on a page it still found, and a
   * cap on deletions would then never be reached.
   */
  private async drain(
    find: (take: number) => Promise<{ id: string }[]>,
    remove: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> {
    let deleted = 0;
    let examined = 0;
    while (examined < ALIAS_SWEEP_MAX_PER_CYCLE) {
      const take = Math.min(
        ALIAS_SWEEP_BATCH_SIZE,
        ALIAS_SWEEP_MAX_PER_CYCLE - examined,
      );
      const ids = (await find(take)).map((row) => row.id);
      if (ids.length === 0) break;
      examined += ids.length;
      deleted += (await remove(ids)).count;
      if (ids.length < take) break;
    }
    return deleted;
  }
}
