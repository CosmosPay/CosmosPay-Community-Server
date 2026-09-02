import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PollarOauthStatus } from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { POLLAR_SWEEP_BATCH_SIZE } from '@/pollar/pollar.constants';

/**
 * Retires bridge handshakes nobody finished.
 *
 * An abandoned login — the consent screen closed, the wallet killed — leaves an
 * `AUTHORIZED` row whose code hash is still a live credential until it is
 * cleared, and a `PENDING` row that will never resolve. Both stop being useful
 * within minutes, so they are expired on a timer rather than lazily on the next
 * read, which for an abandoned handshake never comes.
 *
 * `EXCHANGING` is swept too, and for a subtler reason: that state is only ever
 * held for the length of one redemption request, so a row still in it past the
 * handshake deadline belongs to a replica that died mid-redemption. Left alone
 * it would be stuck forever — `releaseOrFail` runs in the process that crashed.
 */
@Injectable()
export class PollarOauthSweeperService extends ScheduledJob {
  protected readonly logger = new Logger(PollarOauthSweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.PollarOauthSweeper;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { sweep } = this.config.get('pollar', { infer: true });
    return {
      enabled: sweep.enabled,
      intervalMs: sweep.intervalMs,
      description: 'Pollar OAuth handshake sweeper',
    };
  }

  protected async run(): Promise<void> {
    const stale = await this.prisma.pollarOauthSession.findMany({
      where: {
        status: {
          in: [
            PollarOauthStatus.PENDING,
            PollarOauthStatus.AUTHORIZED,
            PollarOauthStatus.EXCHANGING,
          ],
        },
        expiresAt: { lt: new Date() },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: POLLAR_SWEEP_BATCH_SIZE,
    });
    if (stale.length === 0) return;

    const expired = await this.prisma.pollarOauthSession.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: {
        status: PollarOauthStatus.EXPIRED,
        // Clearing the hash is the point of the sweep, not bookkeeping: while it
        // is set, the row is a redeemable code.
        codeHash: null,
        codeExpiresAt: null,
        errorCode: 'BRIDGE_AUTHORIZATION_EXPIRED',
      },
    });
    this.logger.log(`Expired ${expired.count} stale Pollar handshake(s)`);
  }
}
