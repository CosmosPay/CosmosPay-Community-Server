import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { EXCLUDE_REDACTED } from '@/webhooks/webhook-payload-retention';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookDispatcherService } from '@/webhooks/webhook-dispatcher.service';
import {
  CLAIM_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  RETRY_BUDGET_CYCLES,
  SWEEP_BATCH_SIZE,
  SWEEP_CONCURRENCY,
} from '@/webhooks/webhooks.constants';

/**
 * Recovers webhook deliveries that no in-process retry loop is going to finish.
 *
 * The dispatcher retries in-process, blocking on `sleep` between attempts, so a
 * pod killed mid-backoff leaves a `PENDING` row that nothing ever looks at
 * again — before this service there was exactly one write of `PENDING` in the
 * codebase (the insert) and no reader of it. The delivery rows are the queue;
 * this is the poller that drains what the fast path dropped, in the shape the
 * table was already designed for (no broker, no Redis).
 *
 * Mirrors SettlementObserverService and RequestLogRetentionService: fixed
 * interval, no overlapping cycles, `unref` so the timer never keeps the process
 * alive, `clearInterval` on destroy, and one advisory lock so N replicas do not
 * each re-send the same backlog.
 */
@Injectable()
export class WebhookDeliverySweeperService extends ScheduledJob {
  protected readonly logger = new Logger(WebhookDeliverySweeperService.name);
  protected readonly lockKey = AdvisoryLockKey.WebhookDeliverySweeper;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    locks: AdvisoryLockService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.sweepSettings();
    return {
      enabled,
      intervalMs,
      description: enabled
        ? 'Webhook delivery sweeper'
        : 'Webhook delivery sweeper (WEBHOOK_SWEEP_ENABLED=false)',
    };
  }

  /**
   * Overrides the default so the lock covers the claim only.
   *
   * Claiming is short and must be exclusive; the HTTP sends must not be, or one
   * unresponsive integrator would stall every replica's sweep for the duration
   * of its timeout. Stamping `lastAttemptAt` inside the lock is what makes that
   * safe — see {@link claimStranded}.
   */
  protected async cycle(): Promise<void> {
    const claimed = await this.locks.runExclusive(
      this.lockKey,
      () => this.claimStranded(),
      CLAIM_TIMEOUT_MS,
    );
    if (!claimed || claimed.length === 0) return;
    await this.recover(claimed);
  }

  /** Unused: {@link cycle} is overridden, since the lock covers the claim only. */
  protected run(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Selects deliveries nobody is working on and stamps them, returning the ids.
   *
   * Stamping `lastAttemptAt` is the compare-and-swap claim: it takes the rows
   * out of the predicate below, so the next tick — here or on another replica
   * once the lock is released — cannot pick up rows whose send is still in
   * flight. Rows whose endpoint has since been disabled or destination-blocked
   * are left alone: an SSRF block must not be undone by a retry.
   */
  private async claimStranded(): Promise<string[]> {
    const now = Date.now();
    const strandedBefore = new Date(now - this.strandedAfterMs());
    const retryBefore = new Date(now - this.retryCooldownMs());
    const { maxAttempts } = this.config.get('webhooks', { infer: true });

    const candidates = await this.prisma.webhookDelivery.findMany({
      where: {
        endpoint: { enabled: true, destinationBlocked: false },
        // A body past its retention window has been replaced with a marker.
        // Without this the sweeper would sign that marker and POST it to the
        // integrator under a real event type — the signature verifies, so a
        // correct receiver accepts it. The FAILED branch below has no upper age
        // bound, so a delivery whose endpoint was blocked for longer than the
        // retention window and then re-enabled lands here.
        ...EXCLUDE_REDACTED,
        OR: [
          {
            // Nothing finalized it: the process that owned it died.
            status: 'PENDING',
            OR: [
              { lastAttemptAt: null, createdAt: { lt: strandedBefore } },
              { lastAttemptAt: { lt: strandedBefore } },
            ],
          },
          {
            // Gave up in-process but still inside its total attempt budget.
            status: 'FAILED',
            attempts: { lt: maxAttempts * RETRY_BUDGET_CYCLES },
            lastAttemptAt: { lt: retryBefore },
          },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
    });
    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);
    await this.prisma.webhookDelivery.updateMany({
      where: { id: { in: ids } },
      data: { lastAttemptAt: new Date() },
    });
    return ids;
  }

  /** Re-runs the normal delivery path for each claimed row. */
  private async recover(ids: string[]): Promise<void> {
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { id: { in: ids } },
    });
    this.logger.log(
      `Webhook delivery sweep recovering ${rows.length} stranded delivery(ies)`,
    );

    // Bounded concurrency: a backlog is usually a receiver that just came back,
    // and firing the whole batch at it at once is the herd we added jitter to
    // avoid.
    for (let i = 0; i < rows.length; i += SWEEP_CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + SWEEP_CONCURRENCY).map((row) =>
          this.dispatcher.redeliver(row).catch((err: unknown) => {
            this.logger.warn(
              `Sweep could not recover delivery ${row.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }),
        ),
      );
    }
  }

  /**
   * Kill switch and cadence, matching the other background timers: the
   * settlement observer returns early on `OBSERVER_ENABLED=false` and the
   * request-log prune on `REQUEST_LOG_RETENTION_DAYS=0`. An operator must be
   * able to stop this one mid incident without a redeploy.
   *
   * `configuration.ts` builds `webhookSweep` from `WEBHOOK_SWEEP_ENABLED` and
   * `WEBHOOK_SWEEP_INTERVAL_MS`, and is the only place those variables are read.
   * A non-positive interval falls back to the default rather than starting a
   * timer that fires continuously.
   */
  private sweepSettings(): { enabled: boolean; intervalMs: number } {
    const { enabled, intervalMs } = this.config.get('webhookSweep', {
      infer: true,
    });
    return {
      enabled,
      intervalMs: intervalMs > 0 ? intervalMs : DEFAULT_SWEEP_INTERVAL_MS,
    };
  }

  /**
   * How long a `PENDING` row may legitimately stay untouched before it is
   * considered abandoned: the worst case an in-process run can take — every
   * attempt burning its whole connect+read budget, plus the backoff between
   * them (jitter never exceeds the tier, so the linear sum is the ceiling) —
   * doubled, and never less than a minute. Derived rather than configured so it
   * cannot drift out of step with the retry settings it has to outlast.
   */
  private strandedAfterMs(): number {
    const { maxAttempts, backoffMs, connectTimeoutMs, readTimeoutMs } =
      this.config.get('webhooks', { infer: true });
    const attemptBudget = maxAttempts * (connectTimeoutMs + readTimeoutMs);
    const backoffBudget = (backoffMs * maxAttempts * (maxAttempts - 1)) / 2;
    return Math.max(60_000, (attemptBudget + backoffBudget) * 2);
  }

  /** How long a FAILED delivery rests before the sweeper spends more budget. */
  private retryCooldownMs(): number {
    const { backoffMs, maxAttempts } = this.config.get('webhooks', {
      infer: true,
    });
    return Math.max(60_000, backoffMs * maxAttempts * 2);
  }
}
