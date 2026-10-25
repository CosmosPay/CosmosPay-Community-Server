import {
  effectiveZkStatus,
  zkStatusFilter,
} from '@/zk-payments/zk-payment-status';

const NOW = new Date('2026-10-25T14:00:00.000Z');
const before = new Date(NOW.getTime() - 1);
const after = new Date(NOW.getTime() + 1);

describe('effectiveZkStatus', () => {
  it('reads a PENDING payment still open as PENDING', () => {
    expect(
      effectiveZkStatus({ status: 'PENDING', expiresAt: after }, NOW),
    ).toBe('PENDING');
  });

  it('reads a PENDING payment past expiresAt as EXPIRED', () => {
    expect(
      effectiveZkStatus({ status: 'PENDING', expiresAt: before }, NOW),
    ).toBe('EXPIRED');
    // At the instant itself: expired, the same as the list filter (lte).
    expect(effectiveZkStatus({ status: 'PENDING', expiresAt: NOW }, NOW)).toBe(
      'EXPIRED',
    );
  });

  it('never expires a settled payment', () => {
    expect(
      effectiveZkStatus({ status: 'SUCCEEDED', expiresAt: before }, NOW),
    ).toBe('SUCCEEDED');
  });
});

describe('zkStatusFilter', () => {
  it('matches PENDING only while open', () => {
    expect(zkStatusFilter('PENDING', NOW)).toEqual({
      status: 'PENDING',
      expiresAt: { gt: NOW },
    });
  });

  it('matches EXPIRED stored or derived', () => {
    expect(zkStatusFilter('EXPIRED', NOW)).toEqual({
      OR: [
        { status: 'EXPIRED' },
        { status: 'PENDING', expiresAt: { lte: NOW } },
      ],
    });
  });

  it('matches SUCCEEDED as stored', () => {
    expect(zkStatusFilter('SUCCEEDED', NOW)).toEqual({ status: 'SUCCEEDED' });
  });
});
