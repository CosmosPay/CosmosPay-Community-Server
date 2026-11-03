import {
  chainStateOf,
  chainSteps,
} from '@/native-plugins/trustless-work/protected-payment-chain-state';

const NONE = {
  fundedAt: null,
  shippedAt: null,
  approvedAt: null,
  disputedAt: null,
  releasedAt: null,
  resolvedAt: null,
};

describe('chainStateOf', () => {
  it('reads an empty, freshly deployed contract as nothing happened', () => {
    expect(
      chainStateOf({
        contractId: 'C',
        balance: 0,
        milestones: [{ status: 'pending', evidence: '', approved: false }],
        flags: { disputed: false, released: false, resolved: false },
      }),
    ).toEqual({
      balance: 0n,
      funded: false,
      shipped: false,
      evidence: null,
      approved: false,
      disputed: false,
      released: false,
      resolved: false,
    });
  });

  it('reads a balance as funded, and evidence or the shipped status as shipped', () => {
    const state = chainStateOf({
      balance: 125.5,
      milestones: [{ status: 'Shipped', evidence: 'DHL 1', approved: true }],
    });
    expect(state).toMatchObject({
      balance: 1_255_000_000n,
      funded: true,
      shipped: true,
      evidence: 'DHL 1',
      approved: true,
    });
  });

  it('reads a released or resolved contract as funded although it is empty', () => {
    expect(chainStateOf({ balance: 0, flags: { released: true } }).funded).toBe(
      true,
    );
    expect(chainStateOf({ balance: 0, flags: { resolved: true } }).funded).toBe(
      true,
    );
  });

  it('reads a missing field as not yet', () => {
    expect(chainStateOf({})).toMatchObject({
      balance: null,
      funded: false,
      shipped: false,
      approved: false,
    });
  });
});

describe('chainSteps', () => {
  it('takes every step the contract went through, in order', () => {
    expect(
      chainSteps(NONE, {
        balance: 0n,
        funded: true,
        shipped: true,
        evidence: 'x',
        approved: true,
        disputed: false,
        released: true,
        resolved: false,
      }),
    ).toEqual(['FUNDED', 'SHIPPED', 'APPROVED', 'RELEASED']);
  });

  it('skips the steps the row already took', () => {
    expect(
      chainSteps(
        { ...NONE, fundedAt: new Date(), disputedAt: new Date() },
        {
          balance: 0n,
          funded: true,
          shipped: false,
          evidence: null,
          approved: false,
          disputed: false,
          released: false,
          resolved: true,
        },
      ),
    ).toEqual(['RESOLVED']);
  });
});
