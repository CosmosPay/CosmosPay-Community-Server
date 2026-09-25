import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WalletAuthHandshakeStatus,
  WalletLoginCodeStatus,
} from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import {
  WALLET_AUTH_SWEEP_BATCH_SIZE,
  WALLET_AUTH_SWEEP_GRACE_MS,
} from '@/wallet-auth/wallet-auth.constants';

/**
 * Retires sign-ins nobody finished, and deletes the rows that have stopped
 * meaning anything.
 *
 * Two jobs, and the first is the one that matters. An abandoned provider
 * sign-in — the consent screen closed, the wallet killed — leaves an
 * `AUTHORIZED` row, and while it sits there it is a redeemable identity waiting
 * for whoever holds the verifier. A `PENDING` row will simply never resolve.
 * Both stop being useful within minutes, and neither is ever read again, so
 * expiring them lazily on the next read means never.
 *
 * The second job is the grace delete. A terminal row is kept for a day before it
 * is removed, because a row that is simply GONE is indistinguishable from one
 * that never existed — and "you already redeemed this" and "no such handshake"
 * are different sentences for the person looking at the screen.
 */
@Injectable()
export class WalletAuthSweeperService extends ScheduledJob {
  protected readonly logger = new Logger(WalletAuthSweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.WalletAuthSweeper;

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
      description: 'Wallet sign-in handshake sweeper',
    };
  }

  protected async run(): Promise<void> {
    await this.expireHandshakes();
    await this.expireLoginCodes();
    await this.deleteSpent();
  }

  private async expireHandshakes(): Promise<void> {
    const stale = await this.prisma.walletAuthHandshake.findMany({
      where: {
        status: {
          in: [
            WalletAuthHandshakeStatus.PENDING,
            WalletAuthHandshakeStatus.AUTHORIZED,
          ],
        },
        expiresAt: { lt: new Date() },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: WALLET_AUTH_SWEEP_BATCH_SIZE,
    });
    if (stale.length === 0) return;

    const expired = await this.prisma.walletAuthHandshake.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: {
        status: WalletAuthHandshakeStatus.EXPIRED,
        // Clearing the identity is the point of the sweep, not bookkeeping:
        // while it is set, the row is a redeemable sign-in.
        email: null,
        name: null,
        avatar: null,
        subject: null,
      },
    });
    this.logger.log(
      `Expired ${expired.count} stale wallet sign-in handshake(s)`,
    );
  }

  private async expireLoginCodes(): Promise<void> {
    const stale = await this.prisma.walletLoginCode.findMany({
      where: {
        status: WalletLoginCodeStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: WALLET_AUTH_SWEEP_BATCH_SIZE,
    });
    if (stale.length === 0) return;

    const expired = await this.prisma.walletLoginCode.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      // The code hash goes with it: an expired row that still holds it is a
      // guessable credential with nothing checking the clock.
      data: { status: WalletLoginCodeStatus.EXPIRED, codeHash: '' },
    });
    this.logger.log(`Expired ${expired.count} stale wallet login code(s)`);
  }

  /** Remove terminal rows once the grace window has passed. */
  private async deleteSpent(): Promise<void> {
    const cutoff = new Date(Date.now() - WALLET_AUTH_SWEEP_GRACE_MS);

    const handshakes = await this.prisma.walletAuthHandshake.deleteMany({
      where: {
        status: {
          in: [
            WalletAuthHandshakeStatus.REDEEMED,
            WalletAuthHandshakeStatus.FAILED,
            WalletAuthHandshakeStatus.EXPIRED,
          ],
        },
        updatedAt: { lt: cutoff },
      },
    });
    const codes = await this.prisma.walletLoginCode.deleteMany({
      where: {
        status: {
          in: [
            WalletLoginCodeStatus.CLAIMED,
            WalletLoginCodeStatus.LOCKED,
            WalletLoginCodeStatus.EXPIRED,
          ],
        },
        expiresAt: { lt: cutoff },
      },
    });

    const total = handshakes.count + codes.count;
    if (total > 0) {
      this.logger.log(`Deleted ${total} spent wallet sign-in row(s)`);
    }
  }
}
