import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import { PrismaService } from '@/prisma/prisma.service';
import type { PaymentIntent } from '@generated/prisma/client';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import {
  StellarVerifierService,
  type VerificationResult,
} from '@/payment-intents/stellar-verifier.service';
import {
  OBSERVER_MAX_INTENTS_PER_CONSUMER,
  RECONCILE_CONCURRENCY,
  TX_HASH_RE,
} from '@/payment-intents/payment-intents.constants';

/** An intent as the observer reads it: with the consumer its webhooks go to. */
type ObservedIntent = PaymentIntent & { consumer: { apisixUsername: string } };

/**
 * Permanent on-chain observer. On a fixed interval it pulls PENDING intents and
 * asks the verifier whether a matching payment has landed — by the reported
 * txHash when present, otherwise by scanning payments to the destination. On a
 * confirmed match it finalizes the intent (status + txHash) and the webhook
 * event fires automatically, so integrators are notified without polling us.
 * An intent past its lifetime is asked the same question once more before it
 * is expired.
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

  /** One cycle: finalize what is stale, reconcile the rest. */
  protected async run(): Promise<void> {
    const { batchSize } = this.config.get('observer', { infer: true });
    const now = new Date();

    // 1. Finalize intents past their lifetime: SUCCEEDED if paid, else EXPIRED.
    const lapsed = await this.prisma.paymentIntent.findMany({
      where: {
        status: { in: ['PENDING', 'SUBMITTED'] },
        expiresAt: { not: null, lt: now },
      },
      include: { consumer: true },
      take: batchSize,
    });
    await mapLimited(lapsed, RECONCILE_CONCURRENCY, (intent) =>
      this.settleOrExpire(intent).catch((err) => {
        this.logger.error(
          `Expiry check failed for intent ${intent.id}; left ${intent.status} ` +
            `for the next pass: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }),
    );

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
   * pass above gives each of them its last verification; they only reached this
   * query when more had lapsed than one pass finalizes, and each one then paid
   * for a reconcile here on top of the check that decides it there.
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

  private async reconcile(intent: ObservedIntent): Promise<void> {
    // The batch was read before the first Horizon call and draining it takes
    // real time. An intent that lapsed meanwhile is left to the next expiry
    // pass instead of being paid for with a scan.
    if (intent.expiresAt && intent.expiresAt.getTime() <= Date.now()) {
      return;
    }

    const result = await this.verify(intent);

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

  /**
   * Finalizes one intent past its lifetime: SUCCEEDED when its payment is
   * on-chain, EXPIRED only once the verifier has answered and found none.
   *
   * Every such row used to be expired without a look at the chain. A payment
   * that landed after the intent's last reconcile — late in its lifetime, or
   * while a backlog kept it out of the ticks — left it EXPIRED although it was
   * paid, and no PAYMENT_INTENT_SUCCEEDED went out.
   *
   * A verification that throws (Horizon down, throttling, timing out) or a
   * settlement that fails rejects before `markExpired` is reached, so the intent
   * stays as it is for the next pass. "Could not ask" is not "nobody paid" — the
   * confusion that once expired settled swaps during a Horizon outage (see
   * `SettlementObserverService`).
   *
   * One settlement failure is final instead: the hash is already recorded on
   * another of the same consumer's intents (409 `idempotency_conflict`). No
   * later tick clears that — the (consumerId, txHash) index still holds it — so
   * the intent stayed PENDING and took a slot in every expiry batch after, and
   * about `OBSERVER_BATCH_SIZE` of them, each costing a dust payment and a hash
   * the consumer parked on another of its own intents, stalled expiry for every
   * tenant. That intent is expired with a warning. If the other intent's hash is
   * corrected while it is still PENDING or SUBMITTED, `POST /:id/validate`
   * settles this one out of EXPIRED.
   */
  private async settleOrExpire(intent: ObservedIntent): Promise<void> {
    const result = await this.verify(intent);

    if (result.valid && result.txHash) {
      try {
        await this.paymentIntents.markSucceeded(
          intent.id,
          intent.consumer.apisixUsername,
          result.txHash,
          result.payer,
          'observer',
        );
        return;
      } catch (err) {
        // Only the txHash conflict: `markSucceeded` raises no other
        // `idempotency_conflict`, and every other failure is retried.
        if (
          !(err instanceof ApiError) ||
          err.code !== ApiErrorCode.IdempotencyConflict
        ) {
          throw err;
        }
        this.logger.warn(
          `Expiring intent ${intent.id} although ${result.txHash} pays it: ` +
            'that hash is already recorded on another of consumer ' +
            `${intent.consumer.apisixUsername}'s intents, so settling it ` +
            'cannot succeed on any later tick',
        );
      }
    }

    await this.paymentIntents.markExpired(
      intent.id,
      intent.consumer.apisixUsername,
    );
  }

  /**
   * What the chain says about one intent: by its reported hash when it has one
   * (the precise path), otherwise by scanning payments to its destination.
   *
   * A stored hash that is not a transaction hash is scanned for instead of
   * looked up. `PATCH /:id` accepted any string until {@link TX_HASH_RE}, so
   * older rows can carry one, and a lookup of it cannot find anything — while
   * where Horizon refuses it outright (a 400, not a 404) the verifier rethrows,
   * and an intent that throws on every tick would never expire.
   */
  private verify(intent: PaymentIntent): Promise<VerificationResult> {
    return intent.txHash && TX_HASH_RE.test(intent.txHash)
      ? this.verifier.verifyByHash(intent, intent.txHash.toLowerCase())
      : this.verifier.findMatchingPayment(intent);
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
