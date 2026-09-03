import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { StellarObserverService } from '@/payment-intents/stellar-observer.service';

/**
 * The observer's tick runs on every replica behind APISIX and fans a batch of
 * intents out to Horizon. These cover the two properties that made it unsafe at
 * more than one replica: cluster-wide exclusion, and a bounded burst.
 */
describe('StellarObserverService.tick', () => {
  const BATCH_SIZE = 50;

  const config = {
    get: () => ({ enabled: false, intervalMs: 15_000, batchSize: BATCH_SIZE }),
  } as any;

  function pendingIntents(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `pi_${i + 1}`,
      status: 'PENDING',
      txHash: null,
      destination: 'GDEST',
      consumer: { apisixUsername: 'cosmos_u1' },
    }));
  }

  function makePrisma(pending: unknown[]) {
    return {
      paymentIntent: {
        // Call 1 is the expiry sweep, call 2 the pending page.
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue(pending),
      },
    } as any;
  }

  /** A lock that always grants — the single-replica case. */
  function grantingLock() {
    return {
      runExclusive: jest.fn(async (_key: AdvisoryLockKey, work: () => any) =>
        work(),
      ),
    } as unknown as AdvisoryLockService;
  }

  it('sweeps under the payment-intent advisory lock', async () => {
    const lock = grantingLock();
    const prisma = makePrisma([]);
    const observer = new StellarObserverService(
      config,
      prisma,
      {} as any,
      {} as any,
      lock,
    );

    await observer.tick();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      AdvisoryLockKey.PaymentIntentObserver,
      expect.any(Function),
    );
  });

  it('does no work at all when another replica holds the lock', async () => {
    // `runExclusive` resolves undefined without invoking the body — the loser
    // must not read rows or touch Horizon, which is the whole point.
    const lock = {
      runExclusive: jest.fn().mockResolvedValue(undefined),
    } as unknown as AdvisoryLockService;
    const prisma = makePrisma(pendingIntents(5));
    const verifier = { findMatchingPayment: jest.fn() };
    const observer = new StellarObserverService(
      config,
      prisma,
      verifier as any,
      {} as any,
      lock,
    );

    await observer.tick();

    expect(prisma.paymentIntent.findMany).not.toHaveBeenCalled();
    expect(verifier.findMatchingPayment).not.toHaveBeenCalled();
  });

  it('keeps the in-process latch so a slow sweep never overlaps the next tick', async () => {
    const lock = grantingLock();
    const prisma = makePrisma([]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    prisma.paymentIntent.findMany = jest.fn(async () => {
      await gate;
      return [];
    });
    const observer = new StellarObserverService(
      config,
      prisma,
      {} as any,
      {} as any,
      lock,
    );

    const first = observer.tick();
    await observer.tick(); // fires while the first is still in flight
    release();
    await first;

    expect(lock.runExclusive).toHaveBeenCalledTimes(1);
  });

  it('reconciles a full batch with a bounded number of Horizon calls in flight', async () => {
    const pending = pendingIntents(BATCH_SIZE);
    const prisma = makePrisma(pending);

    let inFlight = 0;
    let peak = 0;
    const verifier = {
      findMatchingPayment: jest.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { valid: false, reason: 'No matching payment found yet' };
      }),
    };
    const observer = new StellarObserverService(
      config,
      prisma,
      verifier as any,
      {} as any,
      grantingLock(),
    );

    await observer.tick();

    // Every intent is still visited...
    expect(verifier.findMatchingPayment).toHaveBeenCalledTimes(BATCH_SIZE);
    // ...but never all at once (the unbounded Promise.all failure mode)...
    expect(peak).toBeLessThan(BATCH_SIZE);
    // ...and never one at a time (the serial-loop failure mode).
    expect(peak).toBeGreaterThan(1);
  });

  it('lets the rest of the batch finish when one intent fails', async () => {
    const pending = pendingIntents(6);
    const prisma = makePrisma(pending);
    const verifier = {
      findMatchingPayment: jest.fn(async (intent: { id: string }) => {
        if (intent.id === 'pi_2') throw new Error('Horizon exploded');
        return { valid: false };
      }),
    };
    const observer = new StellarObserverService(
      config,
      prisma,
      verifier as any,
      {} as any,
      grantingLock(),
    );

    await expect(observer.tick()).resolves.toBeUndefined();
    expect(verifier.findMatchingPayment).toHaveBeenCalledTimes(6);
  });

  it('finalizes an intent whose payment the verifier matched', async () => {
    const prisma = makePrisma(pendingIntents(1));
    const matched = { valid: true, txHash: 'a'.repeat(64), payer: 'GP' };
    const verifier = {
      findMatchingPayment: jest.fn().mockResolvedValue(matched),
    };
    const paymentIntents = { markSucceeded: jest.fn().mockResolvedValue({}) };
    const observer = new StellarObserverService(
      config,
      prisma,
      verifier as any,
      paymentIntents as any,
      grantingLock(),
    );

    await observer.tick();

    expect(paymentIntents.markSucceeded).toHaveBeenCalledWith(
      'pi_1',
      'cosmos_u1',
      'a'.repeat(64),
      'GP',
      'observer',
    );
  });
});
