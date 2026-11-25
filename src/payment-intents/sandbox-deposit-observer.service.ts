import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig } from '@/config/configuration';
import { CROSS_CHAIN_OPEN_STATUSES } from '@/cross-chain-swaps/cross-chain-swap-transitions';
import {
  CROSS_CHAIN_OBSERVER_BATCH,
  CROSS_CHAIN_RESCUE_WINDOW_MS,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { PaymentDepositsService } from '@/payment-intents/payment-deposits.service';
import { PrismaService } from '@/prisma/prisma.service';
import { SandboxDepositRoute } from '@/sandbox-settlement/sandbox-deposit-route.service';
import { SandboxSettler } from '@/sandbox-settlement/sandbox-settler.service';

/**
 * Follows the sandbox's deposits (`network: 'testnet'`) the way
 * `PaymentDepositObserverService` follows the mainnet ones: each tick takes the
 * least recently checked open deposits (and EXPIRED ones within the rescue
 * window, since a late deposit is refunded), asks `SandboxSettler` where each
 * stands (reading the test networks, paying out or refunding from the sandbox
 * treasury) and hands the answer to `PaymentDepositsService.applyProviderStatus`,
 * which moves the row, settles the intent and notifies: the same statuses and
 * webhooks as on mainnet.
 *
 * Its own advisory lock, so a slow test network never holds up the mainnet
 * observer, and one runner across replicas, so the treasury's nonces are taken
 * by one sender at a time. Off until the sandbox is configured.
 */
@Injectable()
export class SandboxDepositObserverService extends ScheduledJob {
  protected readonly logger = new Logger(SandboxDepositObserverService.name);
  protected readonly lockKey = AdvisoryLockKey.SandboxDepositObserver;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly route: SandboxDepositRoute,
    private readonly settler: SandboxSettler,
    private readonly deposits: PaymentDepositsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    const configured = this.route.isConfigured();
    return {
      enabled: enabled && configured,
      intervalMs,
      description: configured
        ? 'Sandbox deposit observer (payments from any test network)'
        : 'Sandbox deposit observer (SANDBOX_DEPOSIT_SEED / SANDBOX_TREASURY_PRIVATE_KEY unset)',
    };
  }

  /** Each deposit is a few test-network reads and at most one send. */
  protected lockTimeoutMs(): number {
    return this.config.get('sandbox', { infer: true }).timeoutMs * 6;
  }

  protected async run(): Promise<void> {
    const rescueSince = new Date(Date.now() - CROSS_CHAIN_RESCUE_WINDOW_MS);
    const rows = await this.prisma.paymentDeposit.findMany({
      where: {
        network: 'testnet',
        OR: [
          { status: { in: [...CROSS_CHAIN_OPEN_STATUSES] } },
          { status: 'EXPIRED', expiresAt: { gte: rescueSince } },
        ],
      },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
      take: CROSS_CHAIN_OBSERVER_BATCH,
    });
    for (const deposit of rows) {
      try {
        await this.deposits.applyProviderStatus(
          deposit,
          await this.settler.observe(deposit),
        );
      } catch (err) {
        // One deposit's failure (a test network down, an unfunded treasury)
        // must not stop the batch; the next tick retries it.
        this.logger.error(
          `Sandbox deposit ${deposit.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
