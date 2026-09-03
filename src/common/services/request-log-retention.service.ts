import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import {
  EXCLUDE_REDACTED,
  REDACTED_PAYLOAD,
} from '@/webhooks/webhook-payload-retention';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';

/**
 * Background retention for the two tables that accumulate personal data as a
 * side effect of normal operation.
 *
 * `request_log` is append-only (written by LoggingInterceptor) and holds payer
 * IP / user-agent; without retention it grows forever and the dashboard "API
 * logs" query degrades with volume. Those rows are deleted outright.
 *
 * `webhook_delivery.payload` is the event body as sent, and for
 * `RECEIVER_UPDATED` that body is the provider's complete KYC dossier — tax id,
 * address, identity-document links. The delivery row is the audit trail and is
 * kept; only the body is cleared, and only once the delivery is terminal and
 * past any redelivery window, so nothing that could still be retried loses what
 * it needs to re-send.
 *
 * Each cycle drains in short `batchSize` calls (short locks) and loops until the
 * backlog is empty or `maxPerCycle` is hit, so a large history can catch up
 * without waiting one batch per hour.
 *
 * The timer, the no-overlap latch, `unref`, the advisory lock and the
 * swallow-at-the-boundary all come from {@link ScheduledJob}.
 */
@Injectable()
export class RequestLogRetentionService extends ScheduledJob {
  protected readonly logger = new Logger(RequestLogRetentionService.name);
  protected readonly lockKey = AdvisoryLockKey.RequestLogRetention;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { retentionDays, pruneIntervalMs, deliveryPayloadDays } =
      this.config.get('requestLogRetention', { infer: true });
    return {
      // One timer serves two prunes, so it runs while *either* is enabled.
      enabled: retentionDays > 0 || deliveryPayloadDays > 0,
      intervalMs: pruneIntervalMs,
      description:
        retentionDays > 0 || deliveryPayloadDays > 0
          ? `Retention (request logs ${retentionDays}d, delivery bodies ${deliveryPayloadDays}d)`
          : 'Retention (REQUEST_LOG_RETENTION_DAYS=0, WEBHOOK_PAYLOAD_RETENTION_DAYS=0)',
    };
  }

  protected async run(): Promise<void> {
    await this.prune();
    await this.pruneDeliveryPayloads();
  }

  private async prune(): Promise<void> {
    const { retentionDays, batchSize, maxPerCycle } = this.config.get(
      'requestLogRetention',
      { infer: true },
    );
    if (retentionDays <= 0) return;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const take = Math.max(1, batchSize);
    const cap = Math.max(take, maxPerCycle);
    let deleted = 0;
    // Bound the loop by rows *examined*, not rows deleted. `deleted` only
    // advances when this cycle wins the delete, so a replica racing a sibling
    // (or a concurrent manual cleanup) could see count 0 on every batch while
    // still finding a full page of candidates — leaving `deleted < cap` true
    // forever and turning a bounded prune into an unbounded scan of the table.
    let examined = 0;

    while (deleted < cap && examined < cap) {
      const takeNow = Math.min(take, cap - examined);
      // deleteMany has no take — select a bounded id set first, then delete.
      const stale = await this.prisma.requestLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: takeNow,
      });
      if (stale.length === 0) break;
      examined += stale.length;

      const result = await this.prisma.requestLog.deleteMany({
        where: { id: { in: stale.map((r) => r.id) } },
      });
      deleted += result.count;

      // Short batch ⇒ nothing (or almost nothing) left past the cutoff.
      if (stale.length < takeNow) break;
    }

    if (deleted > 0) {
      this.logger.log(
        `Request log prune deleted ${deleted} row(s) older than ${cutoff.toISOString()}`,
      );
    }
  }

  /**
   * Clears the stored body of settled deliveries past the retention window.
   *
   * Only terminal deliveries are touched. A PENDING or RETRYING row still needs
   * its body to re-send byte for byte — the signature covers the body — so
   * clearing it would turn a recoverable delivery into a permanently broken
   * one. `payload` is non-nullable, so it is replaced with a tombstone marking
   * what was cleared and when, rather than deleted.
   */
  private async pruneDeliveryPayloads(): Promise<void> {
    const { deliveryPayloadDays, batchSize, maxPerCycle } = this.config.get(
      'requestLogRetention',
      { infer: true },
    );
    if (deliveryPayloadDays <= 0) return;

    const cutoff = new Date(
      Date.now() - deliveryPayloadDays * 24 * 60 * 60 * 1000,
    );
    const take = Math.max(1, batchSize);
    const cap = Math.max(take, maxPerCycle);
    let cleared = 0;
    let examined = 0;

    while (examined < cap) {
      const stale = await this.prisma.webhookDelivery.findMany({
        where: {
          createdAt: { lt: cutoff },
          status: { in: ['SUCCEEDED', 'FAILED'] },
          // Excludes rows already cleared, so a cleared row is never picked
          // up twice and the loop terminates.
          ...EXCLUDE_REDACTED,
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: Math.min(take, cap - examined),
      });
      if (stale.length === 0) break;
      examined += stale.length;

      const result = await this.prisma.webhookDelivery.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: { payload: REDACTED_PAYLOAD },
      });
      cleared += result.count;
    }

    if (cleared > 0) {
      this.logger.log(
        `Cleared the body of ${cleared} webhook delivery row(s) older than ${cutoff.toISOString()}`,
      );
    }
  }
}
