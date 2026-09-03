import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { PrismaService } from '@/prisma/prisma.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import { RECONCILE_CONCURRENCY } from '@/payment-intents/payment-intents.constants';

/**
 * Permanent on-chain observer. On a fixed interval it pulls PENDING intents and
 * asks the verifier whether a matching payment has landed — by the reported
 * txHash when present, otherwise by scanning payments to the destination. On a
 * confirmed match it finalizes the intent (status + txHash) and the webhook
 * event fires automatically, so integrators are notified without polling us.
 *
 * Polling (vs Horizon SSE streaming) is intentional: it survives restarts with
 * no cursor/reconnect bookkeeping and naturally picks up newly-created intents.
 */
@Injectable()
export class StellarObserverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarObserverService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly verifier: StellarVerifierService,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly advisoryLock: AdvisoryLockService,
  ) {}

  onModuleInit(): void {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    if (!enabled) {
      this.logger.log('On-chain observer disabled (OBSERVER_ENABLED=false)');
      return;
    }
    this.logger.log(`On-chain observer started (every ${intervalMs}ms)`);
    // `unref` so the interval never keeps the process alive on its own.
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * One reconciliation cycle, guarded twice over.
   *
   * The in-process `running` latch stops a slow sweep from overlapping the next
   * timer fire on *this* replica. The advisory lock is the cluster-wide
   * counterpart: the timer runs on every replica behind APISIX and each one
   * selects the same oldest PENDING rows, so without it N replicas paid N× the
   * Horizon round-trips for identical work. Both are needed — the lock is
   * released as soon as a sweep ends, so it says nothing about the next tick on
   * this process.
   *
   * A replica that loses the lock returns immediately and skips its tick.
   */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.advisoryLock.runExclusive(
        AdvisoryLockKey.PaymentIntentObserver,
        () => this.sweep(),
      );
    } catch (err) {
      // `tick` is fired as `void this.tick()` from a timer, so anything that
      // escapes here is an unhandled rejection and, under Node's default
      // policy, kills the process. A failed reconciliation cycle must only cost
      // one interval.
      this.logger.error('Payment intent observer cycle failed', err as Error);
    } finally {
      this.running = false;
    }
  }

  /** The guarded body of one cycle: expire what is stale, reconcile the rest. */
  private async sweep(): Promise<void> {
    try {
      const { batchSize } = this.config.get('observer', { infer: true });

      // 1. Expire unpaid intents past their lifetime.
      const expired = await this.prisma.paymentIntent.findMany({
        where: {
          status: { in: ['PENDING', 'SUBMITTED'] },
          expiresAt: { not: null, lt: new Date() },
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
      const pending = await this.prisma.paymentIntent.findMany({
        where: { status: 'PENDING' },
        include: { consumer: true },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });

      await mapLimited(pending, RECONCILE_CONCURRENCY, (intent) =>
        this.reconcile(intent).catch((err) => {
          this.logger.error(
            `Reconcile failed for intent ${intent.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }),
      );
    } catch (err) {
      this.logger.error(
        `Observer cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async reconcile(
    intent: Awaited<
      ReturnType<PrismaService['paymentIntent']['findMany']>
    >[number] & { consumer: { apisixUsername: string } },
  ): Promise<void> {
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
