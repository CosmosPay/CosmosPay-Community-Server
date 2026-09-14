import { HttpStatus } from '@nestjs/common';
import { Account, Keypair, Networks } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';

/**
 * `(consumer, memo)` is the idempotency key for a create, and under the shared
 * public API key every anonymous caller is the same consumer — so the key is
 * reachable by anyone. A create that reuses a memo must get the stored intent
 * back only when it asks for the very same payment, and must learn nothing about
 * the stored intent when it does not.
 */
describe('PaymentIntentsService create replay', () => {
  const consumer = {
    username: 'cosmos_public',
    credentialId: 'cred_public',
    environment: 'dev',
    role: 'public',
    permissions: ['payments:write'],
    organizationId: null,
    plan: null,
    planSwapFeeBps: null,
  } as never;

  const attacker = Keypair.random().publicKey();
  const victim = Keypair.random().publicKey();
  const payer = Keypair.random().publicKey();

  /** The intent the first caller created under memo "42". */
  const attackerPay = (overrides: Record<string, unknown> = {}) => ({
    id: 'pi_attacker',
    consumerId: 'c1',
    kind: 'PAY',
    source: null,
    destination: attacker,
    amount: '10',
    asset: 'native',
    assetIssuer: null,
    memo: '42',
    network: 'testnet',
    msg: null,
    callback: null,
    status: 'PENDING',
    xdr: null,
    uri: `web+stellar:pay?destination=${attacker}&amount=10&memo=42&memo_type=MEMO_ID`,
    txHash: null,
    reference: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const storedTx = () =>
    attackerPay({
      id: 'pi_tx',
      kind: 'TX',
      source: payer,
      destination: victim,
      amount: '25.5',
      xdr: 'AAAA',
      uri: 'web+stellar:tx?xdr=AAAA',
    });

  /** `lookups` are what successive (consumer, memo) reads return, in order. */
  function build(...lookups: unknown[]) {
    const findUnique = jest.fn();
    for (const row of lookups) findUnique.mockResolvedValueOnce(row);
    const prisma = {
      consumer: { upsert: jest.fn(async () => ({ id: 'c1' })) },
      paymentIntent: {
        findUnique,
        create: jest.fn(async ({ data }: any) => ({
          id: 'pi_new',
          txHash: null,
          reference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
      },
      webhookEmittedEvent: { create: jest.fn(async () => ({})) },
    } as any;
    const loadAccount = jest.fn(async (id: string) => new Account(id, '1'));
    const stellar = {
      server: () => ({ loadAccount }),
      passphrase: () => Networks.TESTNET,
    };
    const config = {
      get: () => ({
        network: 'testnet',
        baseFee: '100',
        timeoutSeconds: 300,
        ttlSeconds: 3600,
      }),
    } as never;
    const service = new PaymentIntentsService(
      config,
      prisma,
      new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
      {} as never,
      stellar as never,
      new ConsumerResolverService(prisma),
    );
    return { service, prisma, loadAccount };
  }

  const conflictOf = (p: Promise<unknown>) =>
    p.then(() => null).catch((e: unknown) => e as ApiError);

  it('returns the stored intent for an identical retry, creating nothing', async () => {
    const { service, prisma } = build(attackerPay());

    const res = await service.createPay(consumer, {
      destination: attacker,
      amount: '10',
      memo: '42',
    });

    expect(res.id).toBe('pi_attacker');
    expect(res.qr).toContain('data:image/png;base64,');
    expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
  });

  it('refuses a different payment under a memo already taken, revealing nothing of the other intent', async () => {
    const { service, prisma } = build(attackerPay());

    const err = await conflictOf(
      service.createPay(consumer, {
        destination: victim,
        amount: '10',
        memo: '42',
      }),
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err!.code).toBe(ApiErrorCode.IdempotencyConflict);
    // The victim must not be handed the attacker's link, nor learn it exists
    // beyond "this memo is taken".
    expect(err!.message).not.toContain(attacker);
    expect(err!.message).not.toContain('pi_attacker');
    expect(err!.message).not.toContain('10');
    expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
  });

  it('still returns a PAY intent that has since been paid when retried unchanged', async () => {
    const { service } = build(
      attackerPay({
        status: 'SUCCEEDED',
        source: payer,
        txHash: 'a'.repeat(64),
      }),
    );

    const res = await service.createPay(consumer, {
      destination: attacker,
      amount: '10',
      memo: '42',
    });

    expect(res.id).toBe('pi_attacker');
  });

  it('decides a TX replay before any Horizon round trip', async () => {
    const same = build(storedTx());
    const replay = await same.service.createTx(consumer, {
      source: payer,
      destination: victim,
      amount: '25.5',
      memo: '42',
    });
    expect(replay.id).toBe('pi_tx');
    expect(same.loadAccount).not.toHaveBeenCalled();

    const changed = build(storedTx());
    const err = await conflictOf(
      changed.service.createTx(consumer, {
        source: payer,
        destination: victim,
        amount: '999',
        memo: '42',
      }),
    );
    expect(err!.code).toBe(ApiErrorCode.IdempotencyConflict);
    expect(changed.loadAccount).not.toHaveBeenCalled();
  });

  describe('when a concurrent create wins the insert', () => {
    const uniqueViolation = Object.assign(new Error('Unique constraint'), {
      code: 'P2002',
    });

    it('puts the winning row through the same comparison', async () => {
      // Nothing under the memo at first; the insert then loses to a row that
      // pays someone else.
      const { service, prisma } = build(null, attackerPay());
      prisma.paymentIntent.create.mockRejectedValueOnce(uniqueViolation);

      const err = await conflictOf(
        service.createPay(consumer, {
          destination: victim,
          amount: '10',
          memo: '42',
        }),
      );

      expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(err!.code).toBe(ApiErrorCode.IdempotencyConflict);
    });

    it('returns the winner when it is the same payment', async () => {
      const { service, prisma } = build(null, storedTx());
      prisma.paymentIntent.create.mockRejectedValueOnce(uniqueViolation);

      const res = await service.createTx(consumer, {
        source: payer,
        destination: victim,
        amount: '25.5',
        memo: '42',
      });

      expect(res.id).toBe('pi_tx');
    });

    it('asks for a retry when the winner is gone before it can be read', async () => {
      const { service, prisma } = build(null, null);
      prisma.paymentIntent.create.mockRejectedValueOnce(uniqueViolation);

      const err = await conflictOf(
        service.createPay(consumer, { destination: victim, memo: '42' }),
      );

      expect(err!.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(err!.code).toBe(ApiErrorCode.OperationInFlight);
    });
  });
});
