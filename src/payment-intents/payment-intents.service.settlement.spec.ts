import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';

/**
 * One on-chain payment settles at most one payment intent, whoever owns it.
 *
 * The (consumerId, txHash) index only said so per consumer. A tenant that
 * copied another's destination, amount and memo — the memo is the caller's to
 * choose, and every anonymous caller under the shared public key is one
 * consumer — had an intent the payer's single transaction also verified
 * against, and both settled SUCCEEDED on the same hash.
 *
 * The fake database below keeps what these tests depend on: the settlement
 * claim's primary key, and a transaction that rolls its own writes back when
 * its callback throws. Two transactions may run interleaved, as two replicas'
 * would; each undoes only what it wrote.
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

  /** The same payment terms on both intents — B copied A's. */
  const intent = (id: string, consumerId: string, username: string) => ({
    id,
    consumerId,
    consumer: { apisixUsername: username },
    kind: 'PAY',
    chain: 'stellar',
    status: 'PENDING',
    source: null,
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123',
    network: 'testnet',
    uri: 'web+stellar:pay?destination=GDEST',
    txHash: null as string | null,
    reference: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
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
    rows = new Map([
      ['pi_a', intent('pi_a', 'c_a', 'cosmos_a')],
      ['pi_b', intent('pi_b', 'c_b', 'cosmos_b')],
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
