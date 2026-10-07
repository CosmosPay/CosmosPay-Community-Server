import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, BlindpayEnvironment } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { BlindpayClient } from '@/native-plugins/blindpay/blindpay.client';
import { BlindpayOfframpApi } from '@/native-plugins/blindpay/blindpay-offramp.api';
import { BlindpayOnrampApi } from '@/native-plugins/blindpay/blindpay-onramp.api';
import {
  BlindpayObject,
  BlindpaySyncService,
  MirrorRef,
  MoneyResource,
} from '@/native-plugins/blindpay/blindpay-sync.service';
import {
  BLINDPAY_ENVIRONMENTS,
  BLINDPAY_OPEN_EVENT_MIN_AGE_MS,
  BLINDPAY_OPEN_EVENT_RETENTION_MS,
  BLINDPAY_RECONCILE_BATCH,
  BLINDPAY_RECONCILE_INTERVAL_MS,
  BLINDPAY_RECONCILE_LOCK_TIMEOUT_MULTIPLIER,
  BLINDPAY_UNCONFIRMED_AFTER_MS,
  MIRROR_FRESHNESS_MS,
  SETTLED_STATUSES,
} from '@/native-plugins/blindpay/blindpay.constants';

/** The columns a reconciled row is read with, identical for both tables. */
const OPEN_ROW_SELECT = {
  id: true,
  blindpayId: true,
  status: true,
  consumer: { select: { apisixUsername: true } },
} as const;

/**
 * Re-reads from BlindPay whatever the webhook did not settle, and repairs the
 * mirror.
 *
 * The webhook is the primary path for state changes, and it is not enough on
 * its own: a delivery can be acknowledged for a row that did not exist yet, the
 * process can die between recording a delivery and applying it, and a row can
 * miss its terminal event altogether. Each tick, per configured instance:
 *
 *   - open payins and payouts — a provider id, a status that is not settled, and
 *     no write within MIRROR_FRESHNESS_MS — least recently checked first, are
 *     read from BlindPay and brought up to date; a status that moved is
 *     announced, the completion through the terminal emitter it shares with
 *     the webhook, so it notifies once whichever path saw it first;
 *   - webhook events kept open because they matched no row are retried against
 *     the provider's current view of the resource, for
 *     BLINDPAY_OPEN_EVENT_RETENTION_MS;
 *   - rows opened before a provider call that never received an id are marked
 *     BLINDPAY_UNCONFIRMED_STATUS after BLINDPAY_UNCONFIRMED_AFTER_MS and
 *     logged. Nothing here can look them up — BlindPay is only ever asked by
 *     id — and nothing re-sends the create: a caller that saw it fail may
 *     already have paid through another quote.
 *
 * On with the settlement observer (`OBSERVER_ENABLED`), because it is the same
 * kind of work. The cluster-wide lock keeps it to one replica per tick; every
 * write it makes is also a guarded compare-and-swap, so a replica that ran a
 * cycle without the lock would still not double-notify.
 */
@Injectable()
export class BlindpayReconcilerService extends ScheduledJob {
  protected readonly logger = new Logger(BlindpayReconcilerService.name);
  protected readonly lockKey = AdvisoryLockKey.BlindpayReconciler;

  /** How each table's open rows are read upstream. */
  private readonly readers: Readonly<
    Record<
      MoneyResource,
      (env: BlindpayEnvironment, id: string) => Promise<BlindpayObject>
    >
  > = {
    payin: (env, id) => this.onramp.getPayin(env, id),
    payout: (env, id) => this.offramp.getPayout(env, id),
  };

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: BlindpayClient,
    private readonly onramp: BlindpayOnrampApi,
    private readonly offramp: BlindpayOfframpApi,
    private readonly sync: BlindpaySyncService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const { enabled } = this.config.get('observer', { infer: true });
    return {
      enabled,
      intervalMs: BLINDPAY_RECONCILE_INTERVAL_MS,
      description: 'BlindPay reconciler',
    };
  }

  /** Every read in a tick is a BlindPay round-trip; see the constant. */
  protected lockTimeoutMs(): number {
    const { timeoutMs } = this.config.get('blindpay', { infer: true });
    return timeoutMs * BLINDPAY_RECONCILE_LOCK_TIMEOUT_MULTIPLIER;
  }

  protected async run(): Promise<void> {
    for (const env of BLINDPAY_ENVIRONMENTS) {
      // An instance this deployment never configured has nothing to read, and
      // every call to it would only throw `misconfigured`.
      if (!this.client.instance(env).isConfigured) continue;
      for (const resource of ['payin', 'payout'] as const) {
        await this.reconcileRows(env, resource);
        await this.sync.markUnconfirmed(
          resource,
          env,
          new Date(Date.now() - BLINDPAY_UNCONFIRMED_AFTER_MS),
        );
      }
      await this.retryOpenEvents(env);
    }
  }

  private async reconcileRows(
    env: BlindpayEnvironment,
    resource: MoneyResource,
  ): Promise<void> {
    for (const row of await this.openRows(env, resource)) {
      try {
        const fresh = await this.readers[resource](env, row.blindpayId);
        await this.sync.reconcile(resource, row, fresh);
      } catch (err) {
        // One row's failure (BlindPay down for it, a row that will not write)
        // must not stop the rest of the batch. It moves to the back of the
        // queue, so a row that always fails cannot starve the others.
        this.logger.warn(
          `BlindPay ${resource} ${row.blindpayId} (${env}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await this.sync.touchChecked(resource, row.id);
      }
    }
  }

  /**
   * The open rows of one table on one instance, least recently checked first.
   * A row written within MIRROR_FRESHNESS_MS is left alone: its webhooks are
   * evidently arriving.
   */
  private async openRows(
    env: BlindpayEnvironment,
    resource: MoneyResource,
  ): Promise<Array<MirrorRef & { blindpayId: string }>> {
    const where = {
      environment: env,
      blindpayId: { not: null },
      OR: [{ status: null }, { status: { notIn: [...SETTLED_STATUSES] } }],
      updatedAt: { lt: new Date(Date.now() - MIRROR_FRESHNESS_MS) },
    };
    const orderBy = { lastCheckedAt: { sort: 'asc', nulls: 'first' } } as const;
    const rows =
      resource === 'payin'
        ? await this.prisma.payin.findMany({
            where,
            select: OPEN_ROW_SELECT,
            orderBy,
            take: BLINDPAY_RECONCILE_BATCH,
          })
        : await this.prisma.payout.findMany({
            where,
            select: OPEN_ROW_SELECT,
            orderBy,
            take: BLINDPAY_RECONCILE_BATCH,
          });
    return rows.flatMap((row) =>
      row.blindpayId
        ? [
            {
              id: row.id,
              blindpayId: row.blindpayId,
              status: row.status,
              owner: row.consumer.apisixUsername,
            },
          ]
        : [],
    );
  }

  /**
   * Webhook events acknowledged without a row to apply them to. Each is re-read
   * from BlindPay by the resource id it carried and handed back to the sync
   * service, which attributes it through its quote if it can now.
   */
  private async retryOpenEvents(env: BlindpayEnvironment): Promise<void> {
    const now = Date.now();
    const events = await this.prisma.blindpayWebhookEvent.findMany({
      where: {
        environment: env,
        appliedAt: null,
        blindpayId: { not: null },
        createdAt: {
          lt: new Date(now - BLINDPAY_OPEN_EVENT_MIN_AGE_MS),
          gte: new Date(now - BLINDPAY_OPEN_EVENT_RETENTION_MS),
        },
      },
      select: { svixId: true, eventType: true, blindpayId: true },
      orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }],
      take: BLINDPAY_RECONCILE_BATCH,
    });
    for (const event of events) {
      const resource = event.eventType.split('.')[0];
      if (
        (resource !== 'payin' && resource !== 'payout') ||
        !event.blindpayId
      ) {
        continue;
      }
      try {
        const fresh = await this.readers[resource](env, event.blindpayId);
        const applied = await this.sync.retryOpenEvent(event, env, fresh);
        if (!applied) {
          this.logger.warn(
            `BlindPay event '${event.eventType}' for ${event.blindpayId} still matches no quote we issued (svix-id ${event.svixId})`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `BlindPay event '${event.eventType}' for ${event.blindpayId} (svix-id ${event.svixId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await this.sync.noteOpenEventAttempt(event.svixId);
      }
    }
  }
}
