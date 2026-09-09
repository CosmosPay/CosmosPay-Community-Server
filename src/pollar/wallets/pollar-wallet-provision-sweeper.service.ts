import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PollarWalletStatus } from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import {
  POLLAR_WALLET_PROVISION_BACKOFF_MS,
  POLLAR_WALLET_PROVISION_BATCH_SIZE,
  POLLAR_WALLET_PROVISION_CLAIM_TIMEOUT_MS,
  POLLAR_WALLET_PROVISION_CONCURRENCY,
} from '@/pollar/pollar.constants';
import { PollarWalletProvisioningService } from '@/pollar/wallets/pollar-wallet-provisioning.service';

/**
 * Finishes the Pollar wallets a login could not provision.
 *
 * The redemption path deliberately gives up fast — five seconds, one attempt,
 * and a `PENDING` row if that was not enough — because the user is waiting on a
 * login that has already worked. That trade only pays off if something else
 * comes back for the row, and this is it.
 *
 * The backlog it drains is not usually load. It is an operator who has not put
 * the other network's Pollar keys in the environment yet: every login until they
 * do leaves a pending counterpart wallet, and the moment the keys land, one
 * sweep provisions all of them without anyone logging in again.
 */
@Injectable()
export class PollarWalletProvisionSweeperService extends ScheduledJob {
  protected readonly logger = new Logger(
    PollarWalletProvisionSweeperService.name,
  );
  protected readonly lockKey = AdvisoryLockKey.PollarWalletProvisionSweeper;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly provisioning: PollarWalletProvisioningService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    // Shares the handshake sweeper's cadence and kill switch: both drain
    // leftovers of the same login flow, and an operator stopping one mid
    // incident means to stop the other.
    const { sweep } = this.config.get('pollar', { infer: true });
    return {
      enabled: sweep.enabled,
      intervalMs: sweep.intervalMs,
      description: 'Pollar wallet provisioning sweeper',
    };
  }

  /**
   * Overrides the default so the lock covers the claim only.
   *
   * The retries are calls to Pollar, and holding a cluster-wide lock across a
   * provider's timeout would stall every replica's sweep behind one slow
   * response. Pushing `nextAttemptAt` forward inside the lock is what makes
   * releasing it safe — see {@link claimDue}.
   */
  protected async cycle(): Promise<void> {
    const claimed = await this.locks.runExclusive(
      this.lockKey,
      () => this.claimDue(),
      POLLAR_WALLET_PROVISION_CLAIM_TIMEOUT_MS,
    );
    if (!claimed || claimed.length === 0) return;
    await this.retry(claimed);
  }

  /** Unused: {@link cycle} is overridden, since the lock covers the claim only. */
  protected run(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Takes the pending rows whose backoff has elapsed and stamps them.
   *
   * The stamp is the compare-and-swap: pushing `nextAttemptAt` one backoff
   * further takes each row out of the predicate below, so the next tick — here
   * or on another replica once the lock is released — cannot pick up a
   * registration whose request is still in flight. `attempt` overwrites the
   * stamp with the real outcome either way.
   *
   * `nextAttemptAt: null` is included because that is what a row written by a
   * redemption looks like before its first failure.
   */
  private async claimDue(): Promise<string[]> {
    const due = await this.prisma.pollarUserWallet.findMany({
      where: {
        status: PollarWalletStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: POLLAR_WALLET_PROVISION_BATCH_SIZE,
    });
    if (due.length === 0) return [];

    const ids = due.map((row) => row.id);
    await this.prisma.pollarUserWallet.updateMany({
      where: { id: { in: ids } },
      data: {
        nextAttemptAt: new Date(
          Date.now() + POLLAR_WALLET_PROVISION_BACKOFF_MS,
        ),
      },
    });
    return ids;
  }

  /** Re-runs the provisioning call for each claimed row. */
  private async retry(ids: string[]): Promise<void> {
    const rows = await this.prisma.pollarUserWallet.findMany({
      where: { id: { in: ids } },
    });
    this.logger.log(`Retrying ${rows.length} pending Pollar wallet(s)`);

    // Bounded: each registration funds a reserve on Pollar's side, so a backlog
    // is drained in small groups rather than fired at the provider at once.
    for (let i = 0; i < rows.length; i += POLLAR_WALLET_PROVISION_CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + POLLAR_WALLET_PROVISION_CONCURRENCY).map((row) =>
          this.provisioning.attempt(row).catch((err: unknown) => {
            this.logger.warn(
              `Sweep could not retry Pollar wallet ${row.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }),
        ),
      );
    }
  }
}
