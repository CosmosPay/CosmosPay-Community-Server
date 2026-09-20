import {
  privateRfqItemRef,
  privateRfqMemo,
} from '@/private-rfqs/private-rfq-reference';

describe('private RFQ references', () => {
  it('derives a stable 32-byte item reference', () => {
    expect(privateRfqItemRef(' rfq-1 ')).toEqual(privateRfqItemRef('rfq-1'));
    expect(privateRfqItemRef('rfq-1')).toHaveLength(32);
    expect(privateRfqItemRef('rfq-1')).not.toEqual(privateRfqItemRef('rfq-2'));
  });

  it('derives a stable uint64 payment memo', () => {
    const memo = privateRfqMemo('rfq-id');
    expect(memo).toMatch(/^\d+$/);
    expect(BigInt(memo)).toBeGreaterThan(0n);
    expect(BigInt(memo)).toBeLessThan(1n << 64n);
    expect(privateRfqMemo('rfq-id')).toBe(memo);
  });
});
