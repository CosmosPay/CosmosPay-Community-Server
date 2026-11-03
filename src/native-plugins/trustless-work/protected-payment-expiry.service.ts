import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProtectedPayment } from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { chainStateOf } from '@/native-plugins/trustless-work/protected-payment-chain-state';
import { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import {
  PROTECTED_PAYMENT_EXPIRY_INTERVAL_MS,
  PROTECTED_PAYMENT_JOB_BATCH,
  PROTECTED_PAYMENT_JOB_LOCK_TIMEOUT_MULTIPLIER,
  TRUSTLESS_WORK_BUILD_TTL_MS,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

/**
 * Expires the protected payments nobody funded in time: CREATED or
 * AWAITING_FUNDING past `fundingExpiresAt`. Three things keep a deposit from
 * landing in an expired payment:
 *
 *  - the fund route refuses after `fundingExpiresAt`, and a fund it handed out
 *    before then lapses within `TRUSTLESS_WORK_BUILD_TTL_MS`, so a row is only
 *    looked at once that much longer has passed;
 *  - a fund still able to land (built, unexpired) keeps the row open;
 *  - a deployed contract must show a zero balance on-chain. One that holds
 *    funds is left to the sync job, which moves it to FUNDED.
 *
 * On with the settlement observer (`OBSERVER_ENABLED`).
 */
@Injectable()
export class ProtectedPaymentExpiryService extends ScheduledJob {
  protected readonly logger = new Logger(ProtectedPaymentExpiryService.name);
  protected readonly lockKey = AdvisoryLockKey.ProtectedPaymentExpiry;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: TrustlessWorkClient,
    private readonly keys: TrustlessWorkKeys,
    private readonly lifecycle: ProtectedPaymentLifecycle,
    private readonly transactions: ProtectedPaymentTransactionsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    return {
      enabled: this.config.get('observer', { infer: true }).enabled,
      intervalMs: PROTECTED_PAYMENT_EXPIRY_INTERVAL_MS,
      description: 'Protected payment expiry',
    };
  }

  protected lockTimeoutMs(): number {
    return (
      this.client.timeoutMs * PROTECTED_PAYMENT_JOB_LOCK_TIMEOUT_MULTIPLIER
    );
  }

  protected async run(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.protectedPayment.findMany({
      where: {
        status: { in: ['CREATED', 'AWAITING_FUNDING'] },
        fundingExpiresAt: {
          lt: new Date(now.getTime() - TRUSTLESS_WORK_BUILD_TTL_MS),
        },
      },
      orderBy: { fundingExpiresAt: 'asc' },
      take: PROTECTED_PAYMENT_JOB_BATCH,
    });
    for (const row of rows) {
      try {
        if (await this.mayExpire(row, now)) {
          await this.lifecycle.step(row.id, 'EXPIRED');
        }
      } catch (err) {
        this.logger.warn(
          `Could not expire protected payment ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** No deposit can land in it, and its contract (if any) is empty. */
  async mayExpire(row: ProtectedPayment, now: Date): Promise<boolean> {
    if (await this.transactions.outstanding(row.id, 'FUND', now)) return false;
    if (!row.contractId) return true;
    const network = row.network as StellarNetwork;
    // A deployed contract is checked on-chain; without the key to read it,
    // the row waits.
    if (!this.keys.isConfigured(network)) return false;
    const [read] = await this.client.contracts(network, [row.contractId]);
    if (!read) return false;
    const state = chainStateOf(read);
    return state.balance === 0n && !state.funded;
  }
}
