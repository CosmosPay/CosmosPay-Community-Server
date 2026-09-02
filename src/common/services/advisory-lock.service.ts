import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Cluster-wide mutual exclusion for the background timers, using PostgreSQL
 * transaction-level advisory locks.
 *
 * The service runs behind APISIX, which load-balances across replicas, so every
 * `setInterval` in this codebase runs once per replica. Each of them selects the
 * *same* oldest rows — the settlement observers by `status` ordered `createdAt
 * asc`, the retention prune by `createdAt` — so N replicas meant N× the Horizon
 * round-trips for identical work and replicas racing to delete the same tuples.
 * Correctness was already protected by the guarded `updateMany` compare-and-swap
 * downstream; what was wasted was throughput, and Horizon rate limit is a real
 * ceiling.
 *
 * `pg_try_advisory_xact_lock` is the right primitive here rather than the
 * session-level `pg_advisory_lock`:
 *
 *   - it never blocks — a replica that loses the race returns immediately and
 *     skips its tick, which is exactly the desired behaviour for a poller;
 *   - it is released when the transaction ends, including on crash or a dropped
 *     connection, so a killed pod cannot wedge the lock the way a session-level
 *     lock leaked through a pooler can;
 *   - it therefore stays correct behind PgBouncer in transaction-pooling mode,
 *     where session-level locks are unsafe because connections are not sticky.
 *
 * Because the lock lives for the transaction, the guarded work has to run
 * *inside* that transaction — see {@link runExclusive}.
 */
@Injectable()
export class AdvisoryLockService {
  private readonly logger = new Logger(AdvisoryLockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` on the transaction holding advisory lock `key`, or returns
   * `undefined` without running it when another replica holds the lock.
   *
   * `timeoutMs` bounds the surrounding transaction: a poller that talks to
   * Horizon must not hold a database transaction open indefinitely.
   */
  async runExclusive<T>(
    key: AdvisoryLockKey,
    work: () => Promise<T>,
    timeoutMs = 120_000,
  ): Promise<T | undefined> {
    // Tracks how far the transaction got, so the catch below can tell a failure
    // to *acquire* the lock (contention, pool exhaustion, a dropped connection)
    // from a failure *inside* `work`. Swallowing both made this a silent
    // error sink: a sweep that threw on every row looked identical to a replica
    // that simply lost the race, and every caller's own `catch` — which is
    // where the domain-specific logging lives — became unreachable.
    let acquired = false;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
            SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked
          `;
          if (!locked) return undefined;
          acquired = true;
          return await work();
        },
        { timeout: timeoutMs, maxWait: 5_000 },
      );
    } catch (err) {
      if (acquired) {
        // The caller's work failed, not the locking. Every caller wraps its
        // tick in a `catch` that logs with the right context; let it do that
        // rather than reporting someone else's bug as a lock warning.
        throw err;
      }
      // Could not take the lock at all. That is routine under contention and
      // must not take a background tick down — the next tick retries, and the
      // lock is released with the failed transaction either way.
      this.logger.warn(
        `Could not acquire advisory lock ${AdvisoryLockKey[key] ?? key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }
}

/**
 * Lock ids are arbitrary but must be globally unique within the database and
 * stable across deploys — they are the identity of the task, so a renamed
 * constant with a new number silently disables the exclusion. Keep them here and
 * never reuse a retired number.
 */
export enum AdvisoryLockKey {
  SettlementObserver = 881_001,
  PaymentIntentObserver = 881_002,
  RequestLogRetention = 881_003,
  WebhookDeliverySweeper = 881_004,
  PollarOauthSweeper = 881_005,
}
