/**
 * At most `max` holders at once; the others wait in arrival order, or are
 * turned away by {@link tryAcquire}.
 *
 * A released slot is handed straight to the next waiter instead of being freed
 * and re-taken: freeing first lets a caller that arrives in between take the
 * slot too, and the limit is then one over.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error('A concurrency limit is a positive integer');
    }
  }

  /** How many hold a slot right now. */
  get inFlight(): number {
    return this.active;
  }

  /** Takes a slot if one is free; never waits. */
  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  /** Takes a slot, waiting for one when all are held. */
  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  /** Gives the slot back: to the next waiter, or to the pool. */
  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    if (this.active > 0) this.active -= 1;
  }

  /** Runs `task` in a slot, waiting for one first. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}
