import {
  CROSS_CHAIN_STATUS_EVENTS,
  nextStatus,
} from '@/cross-chain-swaps/cross-chain-swap-transitions';

const BEFORE = new Date('2026-10-02T12:00:00Z');
const DEADLINE = new Date('2026-10-02T12:30:00Z');
const AFTER = new Date('2026-10-02T13:00:00Z');

describe('nextStatus', () => {
  it('follows 1Click through the happy path', () => {
    expect(
      nextStatus('AWAITING_DEPOSIT', 'KNOWN_DEPOSIT_TX', BEFORE, DEADLINE),
    ).toBe('DEPOSIT_DETECTED');
    expect(nextStatus('DEPOSIT_DETECTED', 'PROCESSING', BEFORE, DEADLINE)).toBe(
      'PROCESSING',
    );
    expect(nextStatus('PROCESSING', 'SUCCESS', AFTER, DEADLINE)).toBe(
      'SUCCEEDED',
    );
  });

  it('stays put when nothing changed', () => {
    expect(
      nextStatus('AWAITING_DEPOSIT', 'PENDING_DEPOSIT', BEFORE, DEADLINE),
    ).toBeNull();
  });

  it('expires a swap still waiting for its deposit past the deadline', () => {
    expect(
      nextStatus('AWAITING_DEPOSIT', 'PENDING_DEPOSIT', AFTER, DEADLINE),
    ).toBe('EXPIRED');
    expect(
      nextStatus('EXPIRED', 'PENDING_DEPOSIT', AFTER, DEADLINE),
    ).toBeNull();
  });

  it('rescues an EXPIRED swap when a late deposit is refunded', () => {
    expect(nextStatus('EXPIRED', 'REFUNDED', AFTER, DEADLINE)).toBe('REFUNDED');
  });

  it('never moves a terminal swap, whatever 1Click says later', () => {
    for (const terminal of ['SUCCEEDED', 'REFUNDED', 'FAILED'] as const) {
      expect(nextStatus(terminal, 'PROCESSING', BEFORE, DEADLINE)).toBeNull();
      expect(
        nextStatus(terminal, 'PENDING_DEPOSIT', AFTER, DEADLINE),
      ).toBeNull();
    }
  });

  it('ignores a status word it does not know', () => {
    expect(nextStatus('PROCESSING', 'WEIRD_NEW_STATE', BEFORE, DEADLINE)).toBe(
      null,
    );
  });
});

describe('CROSS_CHAIN_STATUS_EVENTS', () => {
  it('gives each outcome its own webhook and the rest one "updated"', () => {
    expect(CROSS_CHAIN_STATUS_EVENTS.SUCCEEDED).toBe(
      'CROSS_CHAIN_SWAP_SUCCEEDED',
    );
    expect(CROSS_CHAIN_STATUS_EVENTS.REFUNDED).toBe(
      'CROSS_CHAIN_SWAP_REFUNDED',
    );
    expect(CROSS_CHAIN_STATUS_EVENTS.PROCESSING).toBe(
      'CROSS_CHAIN_SWAP_UPDATED',
    );
  });
});
