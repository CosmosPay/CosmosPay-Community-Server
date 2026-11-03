import {
  ACTION_STEP,
  canBuild,
  canTransition,
  isTerminal,
  LIFECYCLE_STEPS,
  PROTECTED_PAYMENT_TRANSITIONS,
  stepFrom,
  TERMINAL_PROTECTED_PAYMENT_STATUSES,
} from '@/native-plugins/trustless-work/protected-payment-transitions';

describe('protected payment transitions', () => {
  it('leaves no terminal status', () => {
    for (const status of TERMINAL_PROTECTED_PAYMENT_STATUSES) {
      expect(PROTECTED_PAYMENT_TRANSITIONS[status]).toEqual([]);
      expect(isTerminal(status)).toBe(true);
    }
    expect(isTerminal('DISPUTED')).toBe(false);
  });

  it('goes forward one step at a time, or as far as the chain went', () => {
    expect(canTransition('CREATED', 'AWAITING_FUNDING')).toBe(true);
    expect(canTransition('AWAITING_FUNDING', 'FUNDED')).toBe(true);
    expect(canTransition('FUNDED', 'SHIPPED')).toBe(true);
    expect(canTransition('SHIPPED', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'RELEASED')).toBe(true);
    // Funded and released between two reads of the contract.
    expect(canTransition('FUNDED', 'RELEASED')).toBe(true);
    // Disputed and resolved between two reads.
    expect(canTransition('SHIPPED', 'RESOLVED')).toBe(true);
    expect(canTransition('DISPUTED', 'RESOLVED')).toBe(true);
  });

  it('never goes backwards, and never releases a disputed payment', () => {
    expect(canTransition('SHIPPED', 'FUNDED')).toBe(false);
    expect(canTransition('APPROVED', 'SHIPPED')).toBe(false);
    expect(canTransition('DISPUTED', 'RELEASED')).toBe(false);
    expect(canTransition('DISPUTED', 'FUNDED')).toBe(false);
    expect(canTransition('CREATED', 'FUNDED')).toBe(false);
  });

  it('cancels and expires only what nobody funded', () => {
    expect(canTransition('CREATED', 'CANCELLED')).toBe(true);
    expect(canTransition('AWAITING_FUNDING', 'CANCELLED')).toBe(true);
    expect(canTransition('FUNDED', 'CANCELLED')).toBe(false);
    expect(canTransition('AWAITING_FUNDING', 'EXPIRED')).toBe(true);
    expect(canTransition('FUNDED', 'EXPIRED')).toBe(false);
  });

  it('builds each action only from the statuses a party may take it from', () => {
    expect(canBuild('FUND', 'CREATED')).toBe(true);
    expect(canBuild('FUND', 'FUNDED')).toBe(false);
    expect(canBuild('SHIP', 'FUNDED')).toBe(true);
    expect(canBuild('SHIP', 'SHIPPED')).toBe(false);
    expect(canBuild('APPROVE', 'SHIPPED')).toBe(true);
    expect(canBuild('RELEASE', 'SHIPPED')).toBe(false);
    expect(canBuild('RELEASE', 'APPROVED')).toBe(true);
    expect(canBuild('DISPUTE', 'AWAITING_FUNDING')).toBe(false);
    expect(canBuild('DISPUTE', 'APPROVED')).toBe(true);
    expect(canBuild('RESOLVE', 'DISPUTED')).toBe(true);
    expect(canBuild('RESOLVE', 'FUNDED')).toBe(false);
  });

  it('takes each step from the statuses that reach it, and the deadline from delivery', () => {
    expect(stepFrom(LIFECYCLE_STEPS.RELEASED)).toEqual([
      'AWAITING_FUNDING',
      'FUNDED',
      'SHIPPED',
      'APPROVED',
    ]);
    expect(stepFrom(LIFECYCLE_STEPS.RESOLVED)).toContain('DISPUTED');
    expect(stepFrom(LIFECYCLE_STEPS.DEADLINE_PASSED)).toEqual([
      'FUNDED',
      'SHIPPED',
      'APPROVED',
    ]);
    expect(LIFECYCLE_STEPS.DEADLINE_PASSED.to).toBeNull();
  });

  it('emits one webhook per step, and maps every landed action to its step', () => {
    expect(LIFECYCLE_STEPS.FUNDED.event).toBe('PROTECTED_PAYMENT_FUNDED');
    expect(LIFECYCLE_STEPS.CANCELLED.event).toBe('PROTECTED_PAYMENT_CANCELLED');
    expect(ACTION_STEP).toEqual({
      FUND: 'FUNDED',
      SHIP: 'SHIPPED',
      APPROVE: 'APPROVED',
      RELEASE: 'RELEASED',
      DISPUTE: 'DISPUTED',
      RESOLVE: 'RESOLVED',
    });
  });
});
