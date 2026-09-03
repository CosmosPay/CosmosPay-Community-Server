import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';

/** What a job needs to decide whether, and how often, to run. */
export interface JobSchedule {
  enabled: boolean;
  intervalMs: number;
  /** Logged once at startup when enabled, and when skipped. */
  description?: string;
}

/**
 * The lifecycle every background timer in this service needs, written once.
 *
 * Four jobs — the settlement observer, the payment-intent observer, the webhook
 * delivery sweeper and the retention prune — each carried their own copy of:
 * a `timer` field, a `running` latch, an `onModuleInit` that reads a config flag
 * and calls `setInterval(...).unref()`, an `onModuleDestroy` that clears it, and
 * a `tick` wrapping the work in the advisory lock with a try/catch/finally. They
 * did not even agree on what to call the lock field (`locks` / `lock` /
 * `advisoryLock`).
 *
 * Three guarantees are easy to get subtly wrong and are therefore not left to
 * each subclass:
 *
 *   - **`unref`**, or the timer keeps the process alive through a shutdown.
 *   - **The `running` latch**, released in a `finally`. A tick that throws
 *     without releasing it stops that replica's job permanently — silently,
 *     since nothing else looks at the flag.
 *   - **Swallowing at the boundary.** `tick` is invoked as `void this.tick()`
 *     from a timer, so anything escaping it is an unhandled rejection, and under
 *     Node's default policy that kills a process mid-payment.
 *
 * Subclasses supply only {@link schedule}, {@link lockKey} and {@link run}.
 */
export abstract class ScheduledJob implements OnModuleInit, OnModuleDestroy {
  protected abstract readonly logger: Logger;

  /** The cluster-wide lock this job takes, so only one replica runs a cycle. */
  protected abstract readonly lockKey: AdvisoryLockKey;

  /** Read from config at startup. */
  protected abstract schedule(): JobSchedule;

  /** One cycle. Runs only on the replica that won the lock. */
  protected abstract run(): Promise<void>;

  /**
   * What a tick does, lock included. Override only when the lock must NOT span
   * the whole cycle.
   *
   * The default — everything under the lock — is right for a job whose work is
   * all database. It is wrong for one that does network I/O: the webhook
   * sweeper claims rows under the lock and then sends outside it, because
   * holding a lock across a slow receiver would stall every replica behind one
   * unresponsive integrator. That distinction is a real design decision per
   * job, so it is a seam rather than something the base decides for everyone.
   */
  protected async cycle(): Promise<void> {
    const timeout = this.lockTimeoutMs();
    await this.locks.runExclusive(
      this.lockKey,
      () => this.run(),
      ...(timeout === undefined ? [] : [timeout]),
    );
  }

  /** Bounds the surrounding transaction; override for a longer cycle. */
  protected lockTimeoutMs(): number | undefined {
    return undefined;
  }

  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(protected readonly locks: AdvisoryLockService) {}

  onModuleInit(): void {
    const { enabled, intervalMs, description } = this.schedule();
    const name = description ?? this.constructor.name;
    if (!enabled) {
      this.logger.log(`${name} disabled`);
      return;
    }
    this.logger.log(`${name} started (every ${intervalMs}ms)`);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Never keep the process alive on this job's account.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests, which drive a cycle directly rather than by clock. */
  async tick(): Promise<void> {
    if (this.running) return; // never overlap cycles on this replica
    this.running = true;
    try {
      await this.cycle();
    } catch (err) {
      this.logger.error(`${this.constructor.name} cycle failed`, err as Error);
    } finally {
      this.running = false;
    }
  }
}
