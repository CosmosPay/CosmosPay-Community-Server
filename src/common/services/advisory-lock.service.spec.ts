import { Logger } from '@nestjs/common';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';

/**
 * The `acquired` flag is the whole point of this class and was untested in both
 * directions. Collapsing the two cases back into one silent sink turns every
 * background sweep failure into a no-op indistinguishable from losing the race
 * — the failure mode the class was written to end.
 */
describe('AdvisoryLockService', () => {
  /** A `$transaction` that runs the callback with a `$queryRaw` returning `locked`. */
  function build(locked: boolean, txThrows?: Error) {
    const queryRaw = jest.fn().mockResolvedValue([{ locked }]);
    const $transaction = jest.fn(async (...args: unknown[]) => {
      const fn = args[0] as (tx: unknown) => Promise<unknown>;
      if (txThrows) throw txThrows;
      return fn({ $queryRaw: queryRaw });
    });
    const prisma = { $transaction, $queryRaw: queryRaw } as never;
    return {
      service: new AdvisoryLockService(prisma),
      $transaction,
      queryRaw,
    };
  }

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs the work and returns its result when it wins the lock', async () => {
    const { service } = build(true);
    const work = jest.fn().mockResolvedValue('swept');

    const result = await service.runExclusive(
      AdvisoryLockKey.SettlementObserver,
      work,
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(result).toBe('swept');
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips the work entirely when another replica holds the lock', async () => {
    const { service } = build(false);
    const work = jest.fn();

    const result = await service.runExclusive(
      AdvisoryLockKey.SettlementObserver,
      work,
    );

    // Losing the race is routine, not an error: no work, no result, no noise.
    expect(work).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rethrows a failure from the work — the caller logs it with context', async () => {
    const { service } = build(true);
    const boom = new Error('reconcile blew up');

    await expect(
      service.runExclusive(AdvisoryLockKey.SettlementObserver, () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom);

    // Swallowing this made the class an error sink: a sweep failing on every
    // row looked exactly like a replica that simply lost the race, and the
    // caller's own catch — where the domain logging lives — never ran.
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a failure to ACQUIRE and warns, naming the key', async () => {
    const { service } = build(true, new Error('pool exhausted'));
    const work = jest.fn();

    const result = await service.runExclusive(
      AdvisoryLockKey.WebhookDeliverySweeper,
      work,
    );

    // A background tick must not die because the lock could not be taken.
    expect(result).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('WebhookDeliverySweeper');
    expect(message).toContain('pool exhausted');
  });

  it('passes the key as the advisory lock id and bounds the transaction', async () => {
    const { service, $transaction, queryRaw } = build(true);

    await service.runExclusive(
      AdvisoryLockKey.RequestLogRetention,
      async () => undefined,
      45_000,
    );

    expect(queryRaw.mock.calls[0][1]).toBe(AdvisoryLockKey.RequestLogRetention);
    expect($transaction.mock.calls[0][1]).toMatchObject({ timeout: 45_000 });
  });

  it('gives every task a distinct, stable lock id', () => {
    const ids = Object.values(AdvisoryLockKey).filter(
      (v): v is number => typeof v === 'number',
    );

    // A reused id silently merges two unrelated tasks into one mutex; a renamed
    // constant with a new number silently disables the exclusion.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([881_001, 881_002, 881_003, 881_004]);
  });
});
