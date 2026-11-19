import { P2P_CHAIN_STATUSES } from '@/p2p/p2p-market-abi';
import {
  CHAIN_TO_API_STATUS,
  cancellationStatus,
  medianSeconds,
  merchantAtFault,
  merchantLostDispute,
  openableFrom,
  P2P_EVENT_TRANSITIONS,
  P2P_FINAL_STATUSES,
  P2P_LIVE_STATUSES,
  P2P_ORDER_STATUSES,
} from '@/p2p/p2p-order-status';

describe('P2P order status', () => {
  it('maps every contract status, and only None to nothing', () => {
    for (const status of P2P_CHAIN_STATUSES) {
      const api = CHAIN_TO_API_STATUS[status];
      expect(api === null).toBe(status === 'None');
    }
  });

  it('splits every status into live or final, never both', () => {
    for (const status of P2P_ORDER_STATUSES) {
      expect(
        P2P_LIVE_STATUSES.includes(status) !==
          P2P_FINAL_STATUSES.includes(status),
      ).toBe(true);
    }
  });

  it('moves only out of live statuses', () => {
    for (const { from } of Object.values(P2P_EVENT_TRANSITIONS)) {
      for (const status of from) {
        expect(P2P_LIVE_STATUSES).toContain(status);
      }
    }
  });

  it('follows a late-signed sale, never a late matcher order', () => {
    expect(openableFrom('SELL')).toEqual(['pending', 'failed']);
    expect(openableFrom('BUY')).toEqual(['pending']);
    expect(openableFrom('PAYOUT')).toEqual(['pending']);
  });

  it('reads a cancel after the step deadline as expired, before it as cancelled', () => {
    const base = { acceptDeadline: 100, paymentDeadline: 200 };
    expect(
      cancellationStatus({ ...base, previous: 'awaiting_payment', at: 201 }),
    ).toBe('expired');
    expect(
      cancellationStatus({ ...base, previous: 'awaiting_payment', at: 200 }),
    ).toBe('cancelled');
    expect(
      cancellationStatus({ ...base, previous: 'awaiting_acceptance', at: 150 }),
    ).toBe('expired');
    expect(cancellationStatus({ ...base, previous: 'paid', at: 999 })).toBe(
      'cancelled',
    );
    expect(
      cancellationStatus({
        previous: 'awaiting_payment',
        at: 999,
        acceptDeadline: null,
        paymentDeadline: null,
      }),
    ).toBe('cancelled');
  });

  it('blames the merchant only for what it had to do', () => {
    // A purchase nobody paid is the person's.
    expect(merchantAtFault('BUY', 'awaiting_payment', 'expired', false)).toBe(
      false,
    );
    // A sale the merchant never accepted, or never paid, is the merchant's.
    expect(
      merchantAtFault('SELL', 'awaiting_acceptance', 'expired', false),
    ).toBe(true);
    expect(
      merchantAtFault('PAYOUT', 'awaiting_payment', 'expired', false),
    ).toBe(true);
    // A merchant that cancels is always counted.
    expect(merchantAtFault('BUY', 'awaiting_payment', 'cancelled', true)).toBe(
      true,
    );
    expect(merchantAtFault('SELL', 'paid', 'cancelled', false)).toBe(false);
  });

  it('reads who lost a dispute from the side the merchant was on', () => {
    expect(merchantLostDispute('BUY', 100n, 1n)).toBe(true);
    expect(merchantLostDispute('BUY', 100n, 0n)).toBe(false);
    expect(merchantLostDispute('SELL', 100n, 100n)).toBe(false);
    expect(merchantLostDispute('PAYOUT', 100n, 40n)).toBe(true);
  });

  it('takes the median of release times', () => {
    expect(medianSeconds([])).toBeNull();
    expect(medianSeconds([30, 10, 20])).toBe(20);
    expect(medianSeconds([10, 20, 30, 41])).toBe(25);
  });
});
