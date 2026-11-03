import { ConcurrencyLimiter } from '@/plugins/concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  it('turns a caller away once every slot is held, and frees one on release', () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.release();
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.inFlight).toBe(2);
  });

  it('hands a released slot to the next waiter, never one over the limit', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();
    const order: string[] = [];
    const waiter = limiter.acquire().then(() => order.push('waiter'));
    limiter.release();
    // The slot went to the waiter: a caller arriving now does not get one too.
    expect(limiter.tryAcquire()).toBe(false);
    await waiter;
    expect(order).toEqual(['waiter']);
    expect(limiter.inFlight).toBe(1);
  });

  it('never runs more tasks at once than its limit', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 2));
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(limiter.inFlight).toBe(0);
  });

  it('gives the slot back when a task fails', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(1.5)).toThrow();
  });
});
