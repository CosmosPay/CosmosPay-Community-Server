import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { BankTransferConversion } from '@/native-plugins/koywe/bank-transfer-conversion.service';
import {
  BankTransferOrders,
  ORDER_TRANSFER_SELECT,
} from '@/native-plugins/koywe/bank-transfer-orders.service';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import {
  BANK_TRANSFER_ORDER_RECHECK_MS,
  BANK_TRANSFER_SWEEP_BATCH,
  BANK_TRANSFER_SWEEP_INTERVAL_MS,
  BANK_TRANSFER_SWEEP_MAX_CALLS,
  TRANSFER_ACCOUNT_KYB_RECHECK_MS,
  TRANSFER_ACCOUNT_SWEEP_BATCH,
} from '@/native-plugins/koywe/koywe.constants';
import { TransferAccountsService } from '@/native-plugins/koywe/transfer-accounts.service';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Finishes what the webhook started, once a minute per configured network:
 *
 * - converts the matched deposits with no order yet whose retry is due (a
 *   failed or held attempt, or one that died with its process);
 * - reads back the orders not finished ten minutes after they were last read
 *   (a lost `order.*` delivery, an order held for approval);
 * - reads back the sellers' KYB still pending or in review every ten minutes,
 *   submits one that never was, and opens the virtual account of an approved
 *   account that has none.
 *
 * On with the settlement observer (`OBSERVER_ENABLED`), like the other
 * plugins' jobs; one replica runs a cycle (advisory lock).
 */
@Injectable()
export class BankTransferSweepService extends ScheduledJob {
  protected readonly logger = new Logger(BankTransferSweepService.name);
  protected readonly lockKey = AdvisoryLockKey.BankTransferSweep;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: KoyweClient,
    private readonly conversion: BankTransferConversion,
    private readonly orders: BankTransferOrders,
    private readonly accounts: TransferAccountsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    return {
      enabled: this.config.get('observer', { infer: true }).enabled,
      intervalMs: BANK_TRANSFER_SWEEP_INTERVAL_MS,
      description: 'Bank transfer sweep',
    };
  }

  protected lockTimeoutMs(): number {
    return this.client.timeoutMs * BANK_TRANSFER_SWEEP_MAX_CALLS;
  }

  protected async run(): Promise<void> {
    for (const network of ['public', 'testnet'] as const) {
      if (!this.client.isConfigured(network)) continue;
      await this.sweep(network, new Date());
    }
  }

  /** One network's cycle. Each item fails on its own: the rest still run. */
  async sweep(network: StellarNetwork, now: Date): Promise<void> {
    const due = await this.prisma.bankTransfer.findMany({
      where: {
        network,
        status: 'converting',
        providerOrderId: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { depositedAt: 'asc' },
      take: BANK_TRANSFER_SWEEP_BATCH,
      select: { id: true },
    });
    for (const { id } of due) {
      await this.each(`bank transfer ${id}`, () => this.conversion.convert(id));
    }

    const stale = new Date(now.getTime() - BANK_TRANSFER_ORDER_RECHECK_MS);
    const ordered = await this.prisma.bankTransfer.findMany({
      where: {
        network,
        status: 'converting',
        providerOrderId: { not: null },
        OR: [{ checkedAt: null }, { checkedAt: { lt: stale } }],
      },
      orderBy: { checkedAt: 'asc' },
      take: BANK_TRANSFER_SWEEP_BATCH,
      select: ORDER_TRANSFER_SELECT,
    });
    for (const transfer of ordered) {
      await this.each(`bank transfer ${transfer.id}`, () =>
        this.orders.refresh(transfer),
      );
    }

    const kybStale = new Date(now.getTime() - TRANSFER_ACCOUNT_KYB_RECHECK_MS);
    const accounts = await this.prisma.bankTransferAccount.findMany({
      where: {
        network,
        providerMerchantId: { not: null },
        OR: [
          {
            status: { in: ['pending', 'in_review'] },
            OR: [{ kybCheckedAt: null }, { kybCheckedAt: { lt: kybStale } }],
          },
          { status: 'approved', cvu: null },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: TRANSFER_ACCOUNT_SWEEP_BATCH,
      select: {
        id: true,
        network: true,
        type: true,
        name: true,
        status: true,
        reason: true,
        verificationUrl: true,
        providerMerchantId: true,
        kybId: true,
        kybCheckedAt: true,
        alias: true,
        cvu: true,
        bank: true,
        updatedAt: true,
      },
    });
    for (const account of accounts) {
      await this.each(`bank transfer account ${account.id}`, () =>
        this.accounts.refresh(account),
      );
    }
  }

  private async each(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(
        `Bank transfer sweep: ${what} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
