import { HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiError, ApiErrorCode } from '../common/errors/api-error';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { PaymentIntentsService } from './payment-intents.service';
import { InvalidPaymentIntentTransitionError } from './payment-intent-state-machine';

describe('PaymentIntentsService.transition (guards + audit)', () => {
  const intentBase = {
    id: 'pi_1',
    consumerId: 'c1',
    kind: 'TX',
    source: 'GSRC',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123',
    network: 'testnet',
    msg: null,
    callback: null,
    status: 'PENDING' as string,
    xdr: 'xdr',
    uri: 'web+stellar:tx?xdr=xdr',
    txHash: null as string | null,
    reference: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let row: typeof intentBase;
  let prisma: any;
  let events: EventEmitter2;
  let service: PaymentIntentsService;
  let auditCreates: any[];

  beforeEach(() => {
    row = { ...intentBase };
    auditCreates = [];

    prisma = {
      paymentIntent: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === row.id ? { ...row } : null,
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.id !== row.id || where.status !== row.status) {
            return { count: 0 };
          }
          row = { ...row, ...data, updatedAt: new Date() };
          return { count: 1 };
        }),
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === row.id ? { ...row } : null,
        ),
        findUniqueOrThrow: jest.fn(async ({ where }: any) => {
          if (where.id !== row.id) throw new Error('not found');
          return { ...row };
        }),
      },
      paymentIntentTransition: {
        create: jest.fn(async ({ data }: any) => {
          const created = { id: `tr_${auditCreates.length + 1}`, ...data };
          auditCreates.push(created);
          return created;
        }),
        findMany: jest.fn(async ({ where }: any) =>
          auditCreates.filter((t) => t.intentId === where.intentId),
        ),
      },
      $transaction: jest.fn(async (fn: any) => {
        if (typeof fn === 'function') {
          return fn(prisma);
        }
        return Promise.all(fn);
      }),
      customer: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      // PAYMENT_INTENT_SUCCEEDED / _FAILED are terminal events now, so the
      // emitter claims a dedup row before touching the bus.
      webhookEmittedEvent: { create: jest.fn(async ({ data }: any) => data) },
    };

    events = { emit: jest.fn() } as any;
    const config = {
      get: () => ({
        network: 'testnet',
        baseFee: '100',
        timeoutSeconds: 300,
        ttlSeconds: 3600,
        horizon: { public: 'https://h', testnet: 'https://h' },
      }),
    } as any;

    // Built without a dispatcher (`@Optional`): these tests assert the guard and
    // the audit row, and the emitter's claim-only path still reaches the bus.
    // Delivery durability has its own spec.
    service = new PaymentIntentsService(
      config,
      prisma,
      new WebhookTerminalEmitter(prisma, events),
      {} as any,
      {} as any,
    );
  });

  it('applies a declared transition with an optimistic status guard and writes audit', async () => {
    const updated = await service.transition(row.id, 'SUBMITTED', {
      consumerUsername: 'cosmos_u1',
      actor: 'api',
      reason: 'merchant reported submission',
      txHash: 'abc123',
    });

    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'pi_1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'SUBMITTED',
        txHash: 'abc123',
      }),
    });
    expect(auditCreates).toHaveLength(1);
    expect(auditCreates[0]).toMatchObject({
      intentId: 'pi_1',
      fromStatus: 'PENDING',
      toStatus: 'SUBMITTED',
      actor: 'api',
      txHash: 'abc123',
    });
    expect(updated.status).toBe('SUBMITTED');
    expect(events.emit).toHaveBeenCalled();
  });

  it('rejects an undeclared transition with an explicit, machine-readable error', async () => {
    row.status = 'EXPIRED';

    const err = await service
      .transition(row.id, 'SUCCEEDED', {
        consumerUsername: 'cosmos_u1',
        actor: 'api',
        txHash: 'a'.repeat(64),
      })
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // An integrator branches on `code`, not on the English sentence.
    expect(err!.code).toBe(ApiErrorCode.InvalidStateTransition);
    expect(err!.message).toMatch(/Invalid payment intent transition/);
    // Both ends of the rejected transition stay in the message.
    expect(err!.message).toMatch(/EXPIRED/);
    expect(err!.message).toMatch(/SUCCEEDED/);
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
    expect(auditCreates).toHaveLength(0);
  });

  it('rejects SUCCEEDED without on-chain txHash', async () => {
    await expect(
      service.transition(row.id, 'SUCCEEDED', {
        consumerUsername: 'cosmos_u1',
        actor: 'validate',
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.InvalidStateTransition });
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the prior-status DB guard matches zero rows', async () => {
    prisma.paymentIntent.updateMany.mockResolvedValueOnce({ count: 0 });

    const err = await service
      .transition(row.id, 'SUBMITTED', {
        consumerUsername: 'cosmos_u1',
        actor: 'api',
      })
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err!.code).toBe(ApiErrorCode.OperationInFlight);
    expect(auditCreates).toHaveLength(0);
  });

  it('routes markSucceeded through the guarded transition', async () => {
    const spy = jest.spyOn(service, 'transition');
    await service.markSucceeded(row.id, 'cosmos_u1', 'd'.repeat(64), 'GPAYER');
    expect(spy).toHaveBeenCalledWith(
      row.id,
      'SUCCEEDED',
      expect.objectContaining({
        consumerUsername: 'cosmos_u1',
        actor: 'validate',
        txHash: 'd'.repeat(64),
        payer: 'GPAYER',
      }),
    );
  });

  it('surfaces InvalidPaymentIntentTransitionError.code to API callers', () => {
    const err = new InvalidPaymentIntentTransitionError(
      'EXPIRED',
      'SUCCEEDED',
      'status EXPIRED is terminal and cannot be abandoned',
    );
    expect(err.code).toBe('INVALID_PAYMENT_INTENT_TRANSITION');
  });
});

/**
 * `PATCH /v1/payment-intents/:id` with `{status:'SUCCEEDED'}` used to settle on
 * the state machine's evidence rule alone — "txHash is a non-empty string".
 * That is a formatting check, not a proof: a `payments:write` key could mint a
 * settled payment, fire the terminal webhook, and inflate both the merchant's
 * balances and the platform-wide admin volume figure. SUCCEEDED has no outgoing
 * transitions, so it never self-corrected.
 */
describe('PaymentIntentsService API settlement is chain-verified', () => {
  const consumer = {
    username: 'cosmos_u1',
    credentialId: 'cred_1',
    environment: 'dev',
    role: 'user',
    permissions: ['payments:write'],
    organizationId: null,
    plan: null,
    planSwapFeeBps: null,
  } as never;

  function build(verify: jest.Mock) {
    const row = {
      id: 'pi_1',
      consumerId: 'c1',
      kind: 'PAY',
      status: 'PENDING',
      source: null,
      destination: 'GDEST',
      amount: '25.5',
      asset: 'native',
      assetIssuer: null,
      memo: '123',
      network: 'testnet',
      uri: 'web+stellar:pay?destination=GDEST',
      txHash: null,
      reference: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      paymentIntent: {
        findUnique: jest.fn(async () => ({ ...row })),
        findFirst: jest.fn(async () => ({ ...row })),
        update: jest.fn(async () => ({ ...row })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      },
      consumer: { upsert: jest.fn(async () => ({ id: 'c1' })) },
      paymentIntentTransition: { create: jest.fn(async () => ({})) },
      webhookEmittedEvent: { create: jest.fn(async () => ({})) },
      webhookEndpoint: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: any) =>
        typeof fn === 'function' ? fn(prisma) : Promise.all(fn),
      ),
    } as never;
    const config = {
      get: () => ({
        network: 'testnet',
        baseFee: '100',
        timeoutSeconds: 300,
        ttlSeconds: 3600,
        horizon: { public: 'https://h', testnet: 'https://h' },
      }),
    } as never;
    const service = new PaymentIntentsService(
      config,
      prisma,
      new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
      { verifyByHash: verify } as never,
      {} as never,
    );
    return { service, prisma, verify };
  }

  it('refuses to settle on a hash the chain does not corroborate', async () => {
    const verify = jest.fn().mockResolvedValue({
      valid: false,
      reason: 'Transaction not found on the network',
    });
    const { service, prisma } = build(verify);

    const err = await service
      .update(consumer, 'pi_1', {
        status: 'SUCCEEDED',
        txHash: 'deadbeef',
      } as never)
      .catch((e: unknown) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as ApiError).code).toBe(ApiErrorCode.TransactionRejected);
    // The decisive assertion: the row was never moved to SUCCEEDED.
    const wrote = (prisma as { paymentIntent: { updateMany: jest.Mock } })
      .paymentIntent.updateMany.mock.calls;
    expect(wrote.some((c: any[]) => c[0]?.data?.status === 'SUCCEEDED')).toBe(
      false,
    );
  });

  it('actually consults the chain rather than trusting the request', async () => {
    const verify = jest.fn().mockResolvedValue({
      valid: true,
      txHash: 'a'.repeat(64),
      payer: 'GPAYER',
    });
    const { service } = build(verify);

    await service.update(consumer, 'pi_1', {
      status: 'SUCCEEDED',
      txHash: 'a'.repeat(64),
    } as never);

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pi_1' }),
      'a'.repeat(64),
    );
  });

  it('rejects a settlement with no hash to verify against', async () => {
    const verify = jest.fn();
    const { service } = build(verify);

    const err = await service
      .update(consumer, 'pi_1', { status: 'SUCCEEDED' } as never)
      .catch((e: unknown) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // No point asking Horizon about nothing.
    expect(verify).not.toHaveBeenCalled();
  });
});
