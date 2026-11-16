import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@generated/prisma/client';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig } from '@/config/configuration';
import {
  PAYMENT_RECEIPT_CLAIM_MS,
  PAYMENT_RECEIPT_RETRY_WINDOW_MS,
  PAYMENT_RECEIPT_SWEEP_BATCH,
} from '@/payment-intents/payment-intents.constants';
import { PaymentReceiptsService } from '@/payment-intents/payment-receipts.service';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Sends the receipts that did not go out when their payment settled: the mail
 * sender was down or missing, or the pod died between settling and sending.
 * Each tick takes the settled payments with a checkout session (or a deposit)
 * and neither `receiptSentAt` nor `receiptSkippedAt`
 * from the last `PAYMENT_RECEIPT_RETRY_WINDOW_MS`, whose claim is free or
 * lapsed, and hands each to `PaymentReceiptsService.send`, which claims it
 * again before sending, so a receipt goes out once.
 *
 * On with the observers (`OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS`).
 */
@Injectable()
export class PaymentReceiptSweeperService extends ScheduledJob {
  protected readonly logger = new Logger(PaymentReceiptSweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.PaymentReceiptSweeper;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly receipts: PaymentReceiptsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    return {
      enabled,
      intervalMs,
      description: 'Payment receipt sweeper',
    };
  }

  protected async run(): Promise<void> {
    const now = Date.now();
    const rows = await this.prisma.paymentIntent.findMany({
      where: {
        status: 'SUCCEEDED',
        receiptSentAt: null,
        receiptSkippedAt: null,
        updatedAt: { gte: new Date(now - PAYMENT_RECEIPT_RETRY_WINDOW_MS) },
        OR: [
          { payerSessions: { some: {} } },
          { paidFrom: { not: Prisma.DbNull } },
        ],
        AND: [
          {
            OR: [
              { receiptClaimedAt: null },
              {
                receiptClaimedAt: {
                  lt: new Date(now - PAYMENT_RECEIPT_CLAIM_MS),
                },
              },
            ],
          },
        ],
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: PAYMENT_RECEIPT_SWEEP_BATCH,
    });
    for (const { id } of rows) {
      try {
        await this.receipts.send(id);
      } catch (err) {
        this.logger.warn(
          `Receipt for payment intent ${id} not sent yet: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
