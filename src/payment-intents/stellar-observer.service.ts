import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { PrismaService } from '@/prisma/prisma.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import {
  OBSERVER_MAX_INTENTS_PER_CONSUMER,
  RECONCILE_CONCURRENCY,
} from '@/payment-intents/payment-intents.constants';

/**
 * Permanent on-chain observer. On a fixed interval it pulls PENDING intents and
 * asks the verifier whether a matching payment has landed — by the reported
 * txHash when present, otherwise by scanning payments to the destination. On a
 * confirmed match it finalizes the intent (status + txHash) and the webhook
 * event fires automatically, so integrators are notified without polling us.
 *
 * Polling (vs Horizon SSE streaming) is intentional: it survives restarts with
 * no cursor/reconnect bookkeeping and naturally picks up newly-created intents.
 *
 * The timer runs on every replica behind APISIX and each one selects the same
 * PENDING rows, so without the advisory lock N replicas paid N× the Horizon
 * round trips for identical work; a replica that loses it skips its tick. The
 * lock spans the whole cycle, Horizon calls included — the base's default, not
 * the webhook sweeper's claim-only override — because nothing here claims a
 * row: releasing the lock before reconciling would let the next replica select
 * and pay for the same batch. The timer, the no-overlap latch, `unref` and
 * swallowing a failed cycle come from {@link ScheduledJob}.
 */
@Injectable()
export class StellarObserverService extends ScheduledJob {
  protected readonly logger = new Logger(StellarObserverService.name);
  protected readonly lockKey = AdvisoryLockKey.PaymentIntentObserver;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly verifier: StellarVerifierService,
    private readonly paymentIntents: PaymentIntentsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  /** `OBSERVER_ENABLED` and `OBSERVER_INTERVAL_MS`, via `configuration.ts`. */
  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    return {
      enabled,
      intervalMs,
      description: enabled
        ? 'On-chain observer'
        : 'On-chain observer (OBSERVER_ENABLED=false)',
    };
  }

  /** One cycle: expire what is stale, reconcile the rest. */
  protected async run(): Promise<void> {
    const { batchSize } = this.config.get('observer', { infer: true });
    const now = new Date();

    // 1. Expire unpaid intents past their lifetime.
    const expired = await this.prisma.paymentIntent.findMany({
      where: {
        status: { in: ['PENDING', 'SUBMITTED'] },
        expiresAt: { not: null, lt: now },
      },
      include: { consumer: true },
      take: batchSize,
    });
    for (const intent of expired) {
      await this.paymentIntents
        .markExpired(intent.id, intent.consumer.apisixUsername)
        .catch((err) =>
          this.logger.error(
            `Expire failed for intent ${intent.id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    // 2. Reconcile still-pending intents against the chain.
    const pending = await this.selectPending(batchSize, now);

    await mapLimited(pending, RECONCILE_CONCURRENCY, (intent) =>
      this.reconcile(intent).catch((err) => {
        this.logger.error(
          `Reconcile failed for intent ${intent.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }),
    );
  }

  /**
   * This tick's PENDING intents: unexpired, dealt round-robin across consumers,
   * at most {@link OBSERVER_MAX_INTENTS_PER_CONSUMER} from any one of them.
   *
   * It used to be the oldest `batchSize` rows across every tenant, which let
   * whoever queued the most intents own every tick (see the constant for how
   * cheaply the shared public key arranges that). Ranking each consumer's rows
   * oldest-first and ordering by that rank hands out every consumer's oldest row
   * before anyone's second, so a quiet tenant is served in the next tick however
   * large the backlog in front of it; the cap bounds what one consumer can cost
   * a tick even when nobody else is waiting.
   *
   * Rows already past `expiresAt` are excluded rather than scanned. The expiry
   * pass above finalizes them without touching Horizon; they only reached this
   * query when more had lapsed than one pass expires, and each one then burned
   * a full reconcile to reach a verdict nobody could act on.
   *
   * Prisma has no per-group limit, hence the window function. The rows are then
   * re-read through the client, still PENDING, so `reconcile` keeps its typed
   * intent and consumer and skips anything settled between the two reads.
   */
  private async selectPending(batchSize: number, now: Date) {
    const ranked = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM (
        SELECT "id",
               "createdAt",
               ROW_NUMBER() OVER (
                 PARTITION BY "consumerId" ORDER BY "createdAt", "id"
               ) AS "rank"
        FROM "payment_intent"
        WHERE "status" = 'PENDING'
          AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
      ) AS "eligible"
      WHERE "rank" <= ${OBSERVER_MAX_INTENTS_PER_CONSUMER}
      ORDER BY "rank", "createdAt", "id"
      LIMIT ${batchSize}
    `;
    if (ranked.length === 0) {
      return [];
    }
    return this.prisma.paymentIntent.findMany({
      where: { id: { in: ranked.map((row) => row.id) }, status: 'PENDING' },
      include: { consumer: true },
    });
  }

  private async reconcile(
    intent: Awaited<
      ReturnType<PrismaService['paymentIntent']['findMany']>
    >[number] & { consumer: { apisixUsername: string } },
  ): Promise<void> {
    // The batch was read before the first Horizon call and draining it takes
    // real time. An intent that lapsed meanwhile is left to the next expiry
    // pass instead of being paid for with a scan.
    if (intent.expiresAt && intent.expiresAt.getTime() <= Date.now()) {
      return;
    }

    // Prefer the precise path when a hash was reported; otherwise scan.
    const result = intent.txHash
      ? await this.verifier.verifyByHash(intent, intent.txHash)
      : await this.verifier.findMatchingPayment(intent);

    if (result.valid && result.txHash) {
      await this.paymentIntents.markSucceeded(
        intent.id,
        intent.consumer.apisixUsername,
        result.txHash,
        result.payer,
        'observer',
      );
    }
  }
}

/**
 * Runs `worker` over `items` with at most `limit` calls in flight, preserving
 * the input order of dispatch. Hand-written rather than pulled from a package:
 * N workers draining a shared index is the whole of it, and a dependency for
 * that is supply-chain surface with no upside.
 *
 * `worker` is expected to absorb its own failures — a rejection here aborts the
 * remaining items, which is why the caller attaches `.catch` per intent.
 */
async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const drain = async (): Promise<void> => {
    // `next++` is atomic here: the read-and-increment happens synchronously
    // between awaits, so no two workers ever claim the same item.
    while (next < items.length) {
      await worker(items[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, drain),
  );
}
