import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { SETTLEMENT_RIVALS_MAX } from '@/payment-intents/payment-intents.constants';

/**
 * One on-chain payment settles at most one payment intent, whoever owns it.
 *
 * The (consumerId, txHash) index only said so per consumer. A tenant that
 * copied another's destination, amount and memo — the memo is the caller's to
 * choose, and every anonymous caller under the shared public key is one
 * consumer — had an intent the payer's single transaction also verified
 * against, and both settled SUCCEEDED on the same hash.
 *
 * And it settles the OLDEST intent it pays. With the claim alone the first
 * settlement to run won, and a copycat's observer tick could come before the
 * original's — the copy took the payment and the original expired unpaid.
 *
 * The fake database below keeps what these tests depend on: the settlement
 * claim's primary key, the rival query's filters, and a transaction that rolls
 * its own writes back when its callback throws. Two transactions may run
 * interleaved, as two replicas' would; each undoes only what it wrote.
 */
describe('PaymentIntentsService: one transaction settles one intent', () => {
  const HASH = 'a'.repeat(64);

  const consumerA = {
    username: 'cosmos_a',
    credentialId: 'cred_a',
    environment: 'dev',
    role: 'user',
    permissions: ['payments:write'],
    organizationId: null,
    plan: null,
    planSwapFeeBps: null,
  } as never;
  const consumerB = { ...(consumerA as object), username: 'cosmos_b' } as never;

  const T0 = Date.now();

  /** The same payment terms on every intent — B copied A's. */
  const intent = (
    id: string,
    consumerId: string,
    username: string,
    createdAt: Date,
  ) => ({
    id,
    consumerId,
    consumer: { apisixUsername: username },
    kind: 'PAY',
    chain: 'stellar',
    chainReference: null as string | null,
    status: 'PENDING',
    source: null,
    destination: 'GDEST',
    amount: '25.5' as string | null,
    asset: 'native',
    assetIssuer: null as string | null,
    memo: '123',
    network: 'testnet',
    uri: 'web+stellar:pay?destination=GDEST',
    txHash: null as string | null,
    reference: null,
    expiresAt: new Date(T0 + 60 * 60_000),
    createdAt,
    updatedAt: createdAt,
  });

  type Row = ReturnType<typeof intent>;

  let rows: Map<string, Row>;
  let settlements: Map<string, { intentId: string | null }>;
  let audit: unknown[];
  let emitted: string[];
  /** Resolves every read before any write, when a test arms it. */
  let readBarrier: (() => Promise<void>) | null;

  /** What PostgreSQL raises through `@prisma/adapter-pg` on the claim's key. */
  const pkeyViolation = () =>
    Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: {
        modelName: 'PaymentSettlement',
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index: 'payment_settlement_pkey' },
          },
        },
      },
    });

  /**
   * The subset of a Prisma `where` the rival query uses: AND / OR, equality,
   * `not`, `notIn`, `in` and `lt` (dates compared by time).
   */
  function matches(row: any, where: any): boolean {
    return Object.entries(where).every(([key, cond]: [string, any]) => {
      if (key === 'AND') return cond.every((w: any) => matches(row, w));
      if (key === 'OR') return cond.some((w: any) => matches(row, w));
      const value = row[key];
      const time = (v: unknown) => (v instanceof Date ? v.getTime() : v);
      if (
        cond !== null &&
        typeof cond === 'object' &&
        !(cond instanceof Date)
      ) {
        if ('not' in cond) return value !== cond.not;
        if ('notIn' in cond) return !cond.notIn.includes(value);
        if ('in' in cond) return cond.in.includes(value);
        if ('lt' in cond) return time(value)! < time(cond.lt)!;
        throw new Error(`unsupported filter on ${key}`);
      }
      return time(value) === time(cond);
    });
  }

  /** A client whose writes register an undo with `undo`, when given one. */
  function client(undo?: Array<() => void>): any {
    const owned = (where: any) => {
      const row = rows.get(where.id);
      if (!row) return null;
      if (
        where.consumer?.apisixUsername &&
        row.consumer.apisixUsername !== where.consumer.apisixUsername
      ) {
        return null;
      }
      return row;
    };
    return {
      paymentIntent: {
        findUnique: jest.fn(async ({ where }: any) => {
          const row = rows.get(where.id);
          const copy = row ? { ...row } : null;
          if (readBarrier) await readBarrier();
          return copy;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          const row = owned(where);
          const copy = row ? { ...row } : null;
          if (readBarrier) await readBarrier();
          return copy;
        }),
        findUniqueOrThrow: jest.fn(async ({ where }: any) => {
          const row = rows.get(where.id);
          if (!row) throw new Error('not found');
          return { ...row };
        }),
        findMany: jest.fn(async ({ where, take }: any) =>
          [...rows.values()]
            .filter((row) => matches(row, where))
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            )
            .slice(0, take)
            .map((row) => ({ ...row })),
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = rows.get(where.id);
          if (!row || row.status !== where.status) return { count: 0 };
          const before = { ...row };
          rows.set(where.id, { ...row, ...data });
          undo?.push(() => rows.set(where.id, before));
          return { count: 1 };
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          const row = owned(where);
          if (!row || row.status !== where.status) return { count: 0 };
          rows.delete(where.id);
          return { count: 1 };
        }),
      },
      paymentSettlement: {
        // The primary key: (chain, network, txHash), checked and written in
        // one step, as the index does it.
        create: jest.fn(async ({ data }: any) => {
          const key = `${data.chain}|${data.network}|${data.txHash}`;
          if (settlements.has(key)) throw pkeyViolation();
          settlements.set(key, { intentId: data.intentId });
          undo?.push(() => settlements.delete(key));
          return data;
        }),
      },
      paymentIntentTransition: {
        create: jest.fn(async ({ data }: any) => {
          audit.push(data);
          undo?.push(() => audit.splice(audit.indexOf(data), 1));
          return data;
        }),
      },
      webhookEmittedEvent: {
        create: jest.fn(async ({ data }: any) => {
          emitted.push(data.eventType);
          return data;
        }),
      },
    };
  }

  let prisma: any;
  let verify: jest.Mock;
  let service: PaymentIntentsService;

  beforeEach(() => {
    // A is the original; B copied it a minute later.
    rows = new Map([
      ['pi_a', intent('pi_a', 'c_a', 'cosmos_a', new Date(T0 - 60_000))],
      ['pi_b', intent('pi_b', 'c_b', 'cosmos_b', new Date(T0))],
    ]);
    settlements = new Map();
    audit = [];
    emitted = [];
    readBarrier = null;

    prisma = client();
    prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => {
      const undo: Array<() => void> = [];
      try {
        return await fn(client(undo));
      } catch (err) {
        for (const step of undo.reverse()) step();
        throw err;
      }
    });

    // The chain agrees with both intents: same destination, amount and memo.
    verify = jest.fn().mockResolvedValue({
      valid: true,
      txHash: HASH,
      payer: 'GPAYER',
    });
    const config = {
      get: () => ({
        network: 'testnet',
        baseFee: '100',
        timeoutSeconds: 300,
        ttlSeconds: 3600,
        horizon: { public: 'https://h', testnet: 'https://h' },
      }),
    } as never;
    service = new PaymentIntentsService(
      config,
      prisma,
      new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
      { for: () => ({ verifyByHash: verify }) } as never,
      new Sep7LinkBuilder(config, {} as never, {} as never),
      new ConsumerResolverService(prisma),
      { ensureForPayer: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );
  });

  const errorOf = (pending: Promise<unknown>) =>
    pending.then(() => null).catch((e: unknown) => e as ApiError);

  it("settles one consumer's intent and refuses the copy another consumer made", async () => {
    const first = await service.validate(consumerA, 'pi_a', HASH);
    expect(first).toMatchObject({ valid: true, status: 'SUCCEEDED' });

    const err = await errorOf(service.validate(consumerB, 'pi_b', HASH));

    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
    // Names neither the other intent nor its owner.
    expect(err!.message).not.toMatch(/pi_a|cosmos_a/);

    expect(rows.get('pi_a')!.status).toBe('SUCCEEDED');
    // Rolled back with the claim: still PENDING, carrying no hash.
    expect(rows.get('pi_b')).toMatchObject({ status: 'PENDING', txHash: null });
    expect([...settlements.values()]).toEqual([{ intentId: 'pi_a' }]);
    expect(audit).toHaveLength(1);
    expect(emitted).toEqual(['PAYMENT_INTENT_SUCCEEDED']);
  });

  it('refuses the copy through PATCH status SUCCEEDED too', async () => {
    await service.validate(consumerA, 'pi_a', HASH);

    const err = await errorOf(
      service.update(consumerB, 'pi_b', { status: 'SUCCEEDED', txHash: HASH }),
    );

    expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
    expect(rows.get('pi_b')!.status).toBe('PENDING');
  });

  describe('the oldest intent the payment pays wins it', () => {
    it("refuses the copy even when the copy's settlement runs first, and the original then settles", async () => {
      const err = await errorOf(
        service.markSucceeded('pi_b', 'cosmos_b', HASH, 'GPAYER', 'observer'),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
      // One answer for "settled" and "owed to an older intent": a distinct
      // one would tell the copier the original exists and is unsettled.
      expect(err!.message).not.toMatch(/pi_a|cosmos_a|older/);
      // Asked the chain about the original, with the same predicate that
      // would settle it.
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pi_a' }),
        HASH,
      );
      expect(rows.get('pi_b')!.status).toBe('PENDING');
      expect(settlements.size).toBe(0);

      await service.markSucceeded(
        'pi_a',
        'cosmos_a',
        HASH,
        'GPAYER',
        'observer',
      );

      expect(rows.get('pi_a')!.status).toBe('SUCCEEDED');
      expect([...settlements.values()]).toEqual([{ intentId: 'pi_a' }]);
    });

    it('settles the original whichever of the two racing settlements starts first', async () => {
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => (release = resolve));
      readBarrier = async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothRead;
      };

      // The copy's settlement is issued first.
      const [copy, original] = await Promise.allSettled([
        service.markSucceeded('pi_b', 'cosmos_b', HASH),
        service.markSucceeded('pi_a', 'cosmos_a', HASH),
      ]);

      expect(original.status).toBe('fulfilled');
      expect(copy.status).toBe('rejected');
      expect(((copy as PromiseRejectedResult).reason as ApiError).code).toBe(
        ApiErrorCode.TransactionAlreadySettled,
      );
      expect(rows.get('pi_a')!.status).toBe('SUCCEEDED');
      expect(rows.get('pi_b')!.status).toBe('PENDING');
      expect([...settlements.values()]).toEqual([{ intentId: 'pi_a' }]);
      expect(emitted).toEqual(['PAYMENT_INTENT_SUCCEEDED']);
    });

    /**
     * The limit of the rule, pinned so it is a decision and not a surprise. A
     * copy made BEFORE the original needs the original's memo, destination
     * and amount in advance: a memo the integrator lets this service mint is
     * 64 random bits, so this takes a memo the merchant chose predictably
     * (an order number). Age is the only order this service can see between
     * two tenants describing the same payment, so while the pre-made copy is
     * open it outranks the original — but only that long.
     */
    describe('a copy made BEFORE the original, with a guessed memo', () => {
      beforeEach(() => {
        rows.set('pi_b', {
          ...rows.get('pi_b')!,
          createdAt: new Date(T0 - 120_000),
        });
      });

      it('outranks the original while it is open', async () => {
        const err = await errorOf(
          service.markSucceeded('pi_a', 'cosmos_a', HASH),
        );
        expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
        expect(rows.get('pi_a')!.status).toBe('PENDING');
      });

      it('no longer outranks it once the copy has expired: the original then settles', async () => {
        // Refused while the copy is open...
        await errorOf(service.markSucceeded('pi_a', 'cosmos_a', HASH));
        // ...and the copy lapses unpaid.
        await service.markExpired('pi_b', 'cosmos_b');

        await service.markSucceeded('pi_a', 'cosmos_a', HASH);

        expect(rows.get('pi_a')!.status).toBe('SUCCEEDED');
        expect([...settlements.values()]).toEqual([{ intentId: 'pi_a' }]);
      });
    });

    /**
     * The cost of not counting EXPIRED, pinned: an original that expired no
     * longer outranks a newer copy, so a payment landing after that goes to
     * whichever claims it first.
     */
    it('lets a newer copy win a payment that lands after the original expired', async () => {
      rows.set('pi_a', { ...rows.get('pi_a')!, status: 'EXPIRED' });

      await service.markSucceeded('pi_b', 'cosmos_b', HASH);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
      // ...and the claim keeps the late validate of the original out.
      const err = await errorOf(
        service.markSucceeded('pi_a', 'cosmos_a', HASH),
      );
      expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
      expect(rows.get('pi_a')!.status).toBe('EXPIRED');
    });

    it('is not outranked by an older intent the payment does not pay', async () => {
      // The chain's answer decides, not the shared memo and destination.
      verify.mockImplementation(async (intent: { id: string }) =>
        intent.id === 'pi_a'
          ? { valid: false, reason: 'amount mismatch' }
          : { valid: true, txHash: HASH },
      );

      await service.markSucceeded('pi_b', 'cosmos_b', HASH);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
    });

    it('is not outranked by an older intent that was cancelled', async () => {
      rows.set('pi_a', { ...rows.get('pi_a')!, status: 'CANCELLED' });

      await service.markSucceeded('pi_b', 'cosmos_b', HASH);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
      expect(verify).not.toHaveBeenCalled();
    });

    it('is not decided when the chain cannot be asked about the older intent', async () => {
      verify.mockRejectedValue(new Error('Horizon 503'));

      await expect(
        service.markSucceeded('pi_b', 'cosmos_b', HASH),
      ).rejects.toThrow('Horizon 503');
      expect(rows.get('pi_b')!.status).toBe('PENDING');
    });

    /** Older intents of other consumers, oldest first, each with `terms`. */
    const olderRivals = (n: number, terms: Record<string, unknown> = {}) => {
      for (let i = 0; i < n; i += 1) {
        rows.set(`pi_r${i}`, {
          ...intent(
            `pi_r${i}`,
            `c_r${i}`,
            `cosmos_r${i}`,
            new Date(T0 - 600_000 + 1_000 * i),
          ),
          ...terms,
        });
      }
    };

    /**
     * A count never refuses a settlement. Past the cap it used to, without
     * asking the chain, so six junk intents refused every settlement after
     * them.
     */
    it('is not refused by more older look-alikes than the cap when the chain says none is paid', async () => {
      rows.delete('pi_a');
      olderRivals(SETTLEMENT_RIVALS_MAX + 2);
      verify.mockImplementation(async (rival: { id: string }) =>
        rival.id === 'pi_b'
          ? { valid: true, txHash: HASH }
          : { valid: false, reason: 'not this payment' },
      );

      await service.markSucceeded('pi_b', 'cosmos_b', HASH);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
      // The bound on chain calls: the oldest SETTLEMENT_RIVALS_MAX, no more.
      expect(verify).toHaveBeenCalledTimes(SETTLEMENT_RIVALS_MAX);
    });

    it('leaves a paid rival past the oldest few to the claim instead of refusing', async () => {
      rows.delete('pi_a');
      olderRivals(SETTLEMENT_RIVALS_MAX + 1);
      const paidPastWindow = `pi_r${SETTLEMENT_RIVALS_MAX}`;
      verify.mockImplementation(async (rival: { id: string }) =>
        rival.id === paidPastWindow
          ? { valid: true, txHash: HASH }
          : { valid: false, reason: 'not this payment' },
      );

      await service.markSucceeded('pi_b', 'cosmos_b', HASH);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
      expect(verify).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: paidPastWindow }),
        HASH,
      );
    });

    it('does not even ask about older intents for another amount or asset', async () => {
      rows.delete('pi_a');
      olderRivals(SETTLEMENT_RIVALS_MAX + 1, { amount: '1' });
      rows.set('pi_usdc', {
        ...intent('pi_usdc', 'c_usdc', 'cosmos_usdc', new Date(T0 - 1_000)),
        asset: 'USDC',
        assetIssuer: 'GISSUER',
      });

      await service.markSucceeded('pi_b', 'cosmos_b', HASH);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
      expect(verify).not.toHaveBeenCalled();
    });

    it('matches an older rival for the same amount in another spelling', async () => {
      rows.set('pi_a', { ...rows.get('pi_a')!, amount: '25.5000000' });

      const err = await errorOf(
        service.markSucceeded('pi_b', 'cosmos_b', HASH),
      );

      expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
    });

    describe('open-amount intents', () => {
      it('an older open-amount rival, paid by any amount, outranks a fixed one', async () => {
        rows.set('pi_a', { ...rows.get('pi_a')!, amount: null });

        const err = await errorOf(
          service.markSucceeded('pi_b', 'cosmos_b', HASH),
        );

        expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
      });

      it('an open-amount intent is outranked by an older rival of any amount the payment pays', async () => {
        rows.set('pi_a', { ...rows.get('pi_a')!, amount: '99' });
        rows.set('pi_b', { ...rows.get('pi_b')!, amount: null });

        const err = await errorOf(
          service.markSucceeded('pi_b', 'cosmos_b', HASH),
        );

        expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
        expect(verify).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'pi_a' }),
          HASH,
        );
      });
    });

    /**
     * Monad without a relayer: the payment carries nothing that is the
     * intent's own, so age would favour whoever pre-creates intents at a
     * merchant's address. Two direct intents are left to the claim.
     */
    it('does not rank direct-mode Monad intents: older exact copies at the merchant address do not block', async () => {
      const direct = {
        chain: 'monad',
        destination: '0xMERCHANT',
        assetIssuer: '0xTOKEN',
      };
      rows.delete('pi_a');
      olderRivals(SETTLEMENT_RIVALS_MAX + 1, direct);
      rows.set('pi_b', { ...rows.get('pi_b')!, ...direct });

      await service.markSucceeded('pi_b', 'cosmos_b', `0x${'d'.repeat(64)}`);

      expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
      expect(verify).not.toHaveBeenCalled();
    });

    /**
     * Monad with a relayer: the original's payer pays its deposit address, and
     * the relayer's forward settles it under the FORWARD's hash. A copy whose
     * destination is that deposit address was paid by the payer's own
     * transaction — a different hash, so the claim never met it.
     */
    it("refuses a Monad copy paid at another intent's deposit address after the forward settled it", async () => {
      const PAYER_TX = `0x${'b'.repeat(64)}`;
      const monad = { chain: 'monad', destination: '0xMERCHANT' };
      rows.set('pi_a', {
        ...rows.get('pi_a')!,
        ...monad,
        chainReference: '0xDEPOSIT',
        status: 'SUCCEEDED',
        txHash: `0x${'c'.repeat(64)}`,
      });
      rows.set('pi_b', {
        ...rows.get('pi_b')!,
        ...monad,
        destination: '0xDEPOSIT',
      });

      const err = await errorOf(
        service.markSucceeded('pi_b', 'cosmos_b', PAYER_TX),
      );

      expect(err!.code).toBe(ApiErrorCode.TransactionAlreadySettled);
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pi_a' }),
        PAYER_TX,
      );
      expect(rows.get('pi_b')!.status).toBe('PENDING');
    });
  });

  it('holds when both settlements race past their reads before either writes', async () => {
    // Both transitions read their intent PENDING, and no claim exists yet for
    // either to see: a check-then-write would let both through. Only the
    // claim's key decides.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    readBarrier = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothRead;
    };

    const outcomes = await Promise.allSettled([
      service.markSucceeded('pi_a', 'cosmos_a', HASH, 'GPAYER'),
      service.markSucceeded('pi_b', 'cosmos_b', HASH, 'GPAYER'),
    ]);

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ApiError);
    expect((lost[0].reason as ApiError).code).toBe(
      ApiErrorCode.TransactionAlreadySettled,
    );

    const statuses = [...rows.values()].map((r) => r.status).sort();
    expect(statuses).toEqual(['PENDING', 'SUCCEEDED']);
    expect(settlements.size).toBe(1);
    expect(audit).toHaveLength(1);
    expect(emitted).toEqual(['PAYMENT_INTENT_SUCCEEDED']);
  });

  it('lets the same hash settle an intent on another network', async () => {
    rows.set('pi_b', { ...rows.get('pi_b')!, network: 'public' });

    await service.markSucceeded('pi_a', 'cosmos_a', HASH);
    await service.markSucceeded('pi_b', 'cosmos_b', HASH);

    expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
    expect(settlements.size).toBe(2);
  });

  it('claims nothing on a transition that does not settle', async () => {
    await service.markFailed('pi_a', 'cosmos_a', HASH);

    expect(settlements.size).toBe(0);
    // ...so the payment is still there to settle the intent it does pay.
    await service.markSucceeded('pi_b', 'cosmos_b', HASH);
    expect(rows.get('pi_b')!.status).toBe('SUCCEEDED');
  });

  /**
   * DELETE read the status, refused a SUCCEEDED intent, then deleted by id
   * unconditionally — so an intent the observer settled in between was deleted
   * after its settlement had been notified.
   */
  describe('deleting an intent', () => {
    it('refuses one that settles between the read and the delete', async () => {
      // The delete's read sees PENDING; the observer settles the intent before
      // the delete is issued.
      readBarrier = async () => {
        readBarrier = null;
        await service.markSucceeded('pi_a', 'cosmos_a', HASH);
      };

      const err = await errorOf(service.remove(consumerA, 'pi_a'));

      expect(err).toBeInstanceOf(ApiError);
      expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(err!.code).toBe(ApiErrorCode.OperationInFlight);
      expect(rows.get('pi_a')!.status).toBe('SUCCEEDED');
      expect(prisma.paymentIntent.deleteMany).toHaveBeenCalledWith({
        where: {
          id: 'pi_a',
          consumer: { apisixUsername: 'cosmos_a' },
          status: 'PENDING',
        },
      });
    });

    it('deletes an unpaid intent', async () => {
      await expect(service.remove(consumerA, 'pi_a')).resolves.toEqual({
        id: 'pi_a',
        deleted: true,
      });
      expect(rows.has('pi_a')).toBe(false);
    });

    it('still refuses a paid intent with a 400', async () => {
      await service.markSucceeded('pi_a', 'cosmos_a', HASH);

      const err = await errorOf(service.remove(consumerA, 'pi_a'));

      expect(err!.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err!.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(rows.has('pi_a')).toBe(true);
    });

    it("is a 404 on another consumer's intent", async () => {
      const err = await errorOf(service.remove(consumerB, 'pi_a'));

      expect(err!.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(rows.has('pi_a')).toBe(true);
    });
  });
});
