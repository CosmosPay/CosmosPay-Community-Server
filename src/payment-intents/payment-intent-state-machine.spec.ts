import {
  PAYMENT_INTENT_STATUSES,
  PAYMENT_INTENT_TRANSITIONS,
  SUCCESS_REQUIRES_TX_HASH,
  TERMINAL_STATUSES,
  VERIFIED_SETTLEMENT_ONLY_FROM,
  type PaymentIntentStatusName,
} from '@/payment-intents/payment-intent-transitions';
import {
  assertTransition,
  canTransition,
  InvalidPaymentIntentTransitionError,
  isTerminalStatus,
} from '@/payment-intents/payment-intent-state-machine';

describe('PaymentIntent state machine (spec / graph)', () => {
  it('declares every Prisma status exactly once in the graph', () => {
    expect(Object.keys(PAYMENT_INTENT_TRANSITIONS).sort()).toEqual(
      [...PAYMENT_INTENT_STATUSES].sort(),
    );
  });

  it('marks SUCCEEDED, FAILED, CANCELLED, EXPIRED as terminal', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
    }
  });

  it('keeps SUCCEEDED, FAILED and CANCELLED absorbing', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      expect(PAYMENT_INTENT_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('gives EXPIRED one exit, to SUCCEEDED, and only on a verified payment', () => {
    expect(PAYMENT_INTENT_TRANSITIONS.EXPIRED).toEqual(['SUCCEEDED']);
    expect(VERIFIED_SETTLEMENT_ONLY_FROM).toEqual(['EXPIRED']);
  });

  it('requires on-chain evidence to reach SUCCEEDED', () => {
    expect(SUCCESS_REQUIRES_TX_HASH).toBe(true);
  });

  describe('canTransition — full adjacency matrix', () => {
    const cases: Array<{
      from: PaymentIntentStatusName;
      to: PaymentIntentStatusName;
      allowed: boolean;
    }> = [];

    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_STATUSES) {
        cases.push({
          from,
          to,
          allowed: PAYMENT_INTENT_TRANSITIONS[from].includes(to),
        });
      }
    }

    it.each(cases)(
      '$from → $to (allowed=$allowed)',
      ({ from, to, allowed }) => {
        expect(canTransition(from, to)).toBe(allowed);
      },
    );
  });

  describe('assertTransition — valid edges', () => {
    const valid: Array<{
      from: PaymentIntentStatusName;
      to: PaymentIntentStatusName;
      evidence?: { txHash?: string; verifiedOnChain?: boolean };
    }> = [];

    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_TRANSITIONS[from]) {
        valid.push({
          from,
          to,
          evidence:
            to === 'SUCCEEDED'
              ? { txHash: 'a'.repeat(64), verifiedOnChain: true }
              : undefined,
        });
      }
    }

    it.each(valid)('allows $from → $to', ({ from, to, evidence }) => {
      expect(() => assertTransition(from, to, evidence)).not.toThrow();
    });
  });

  describe('assertTransition — invalid edges', () => {
    const invalid: Array<{
      from: PaymentIntentStatusName;
      to: PaymentIntentStatusName;
    }> = [];

    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_STATUSES) {
        if (!PAYMENT_INTENT_TRANSITIONS[from].includes(to)) {
          invalid.push({ from, to });
        }
      }
    }

    it.each(invalid)(
      'rejects undeclared $from → $to with an explicit error',
      ({ from, to }) => {
        expect(() =>
          assertTransition(from, to, {
            txHash: to === 'SUCCEEDED' ? 'a'.repeat(64) : undefined,
          }),
        ).toThrow(InvalidPaymentIntentTransitionError);

        try {
          assertTransition(from, to, {
            txHash: to === 'SUCCEEDED' ? 'a'.repeat(64) : undefined,
          });
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidPaymentIntentTransitionError);
          const e = err as InvalidPaymentIntentTransitionError;
          expect(e.code).toBe('INVALID_PAYMENT_INTENT_TRANSITION');
          expect(e.from).toBe(from);
          expect(e.to).toBe(to);
          expect(e.message).toMatch(/Invalid payment intent transition/);
        }
      },
    );
  });

  describe('assertTransition — terminal immutability', () => {
    it.each(TERMINAL_STATUSES)(
      'cannot leave terminal status %s on a txHash alone',
      (from) => {
        for (const to of PAYMENT_INTENT_STATUSES) {
          expect(() =>
            assertTransition(from, to, {
              txHash: 'b'.repeat(64),
            }),
          ).toThrow(InvalidPaymentIntentTransitionError);
        }
      },
    );

    it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'] as const)(
      'cannot leave %s even on a verified payment',
      (from) => {
        for (const to of PAYMENT_INTENT_STATUSES) {
          expect(() =>
            assertTransition(from, to, {
              txHash: 'b'.repeat(64),
              verifiedOnChain: true,
            }),
          ).toThrow(InvalidPaymentIntentTransitionError);
        }
      },
    );
  });

  describe('assertTransition — on-chain evidence for SUCCEEDED', () => {
    it.each(['PENDING', 'SUBMITTED'] as const)(
      'rejects %s → SUCCEEDED without txHash',
      (from) => {
        expect(() => assertTransition(from, 'SUCCEEDED')).toThrow(
          InvalidPaymentIntentTransitionError,
        );
        expect(() =>
          assertTransition(from, 'SUCCEEDED', { txHash: null }),
        ).toThrow(InvalidPaymentIntentTransitionError);
        expect(() =>
          assertTransition(from, 'SUCCEEDED', { txHash: '' }),
        ).toThrow(InvalidPaymentIntentTransitionError);
        expect(() =>
          assertTransition(from, 'SUCCEEDED', { txHash: '   ' }),
        ).toThrow(InvalidPaymentIntentTransitionError);
      },
    );

    it.each(['PENDING', 'SUBMITTED'] as const)(
      'allows %s → SUCCEEDED with a non-empty txHash',
      (from) => {
        expect(() =>
          assertTransition(from, 'SUCCEEDED', {
            txHash: 'c'.repeat(64),
          }),
        ).not.toThrow();
      },
    );
  });

  /**
   * The observer expired lapsed intents without asking the chain, and EXPIRED
   * had no exit: an intent paid late in its lifetime stayed EXPIRED and its
   * PAYMENT_INTENT_SUCCEEDED never went out. The way back must not become a way
   * for a caller to settle a closed intent on its own say-so.
   */
  describe('assertTransition — settling an EXPIRED intent', () => {
    it('allows EXPIRED → SUCCEEDED on a payment verified on-chain', () => {
      expect(() =>
        assertTransition('EXPIRED', 'SUCCEEDED', {
          txHash: 'd'.repeat(64),
          verifiedOnChain: true,
        }),
      ).not.toThrow();
    });

    it('refuses EXPIRED → SUCCEEDED on a txHash alone', () => {
      let caught: unknown;
      try {
        assertTransition('EXPIRED', 'SUCCEEDED', { txHash: 'd'.repeat(64) });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidPaymentIntentTransitionError);
      expect((caught as Error).message).toMatch(/verified on-chain/);
    });

    it('still requires the txHash itself', () => {
      expect(() =>
        assertTransition('EXPIRED', 'SUCCEEDED', { verifiedOnChain: true }),
      ).toThrow(InvalidPaymentIntentTransitionError);
    });

    it.each([
      'PENDING',
      'SUBMITTED',
      'FAILED',
      'CANCELLED',
      'EXPIRED',
    ] as const)('never reopens EXPIRED → %s', (to) => {
      expect(() =>
        assertTransition('EXPIRED', to, {
          txHash: 'd'.repeat(64),
          verifiedOnChain: true,
        }),
      ).toThrow(InvalidPaymentIntentTransitionError);
    });
  });
});
