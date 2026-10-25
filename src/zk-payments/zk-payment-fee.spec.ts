import { splitZkPayment, zkPaymentFee } from '@/zk-payments/zk-payment-fee';
import { ZK_PAYMENT_FEE_BPS } from '@/zk-payments/zk-payments.constants';

describe('zkPaymentFee', () => {
  it('is 1 bps of the amount when it divides evenly', () => {
    // 100 XLM = 1,000,000,000 stroops; 0.01% = 100,000 stroops (0.01 XLM).
    expect(zkPaymentFee(1_000_000_000n, 1)).toBe(100_000n);
  });

  it('rounds up, never down', () => {
    // 10,001 stroops * 1 / 10,000 = 1.0001 -> 2.
    expect(zkPaymentFee(10_001n, 1)).toBe(2n);
    // 19,999 / 10,000 = 1.9999 -> 2.
    expect(zkPaymentFee(19_999n, 1)).toBe(2n);
    // Exactly 2 stays 2.
    expect(zkPaymentFee(20_000n, 1)).toBe(2n);
  });

  it('never charges less than one stroop', () => {
    expect(zkPaymentFee(1n, 1)).toBe(1n);
    expect(zkPaymentFee(9_999n, 1)).toBe(1n);
    // Even a zero rate charges the floor: the fee transfer is part of the protocol.
    expect(zkPaymentFee(1_000_000n, 0)).toBe(1n);
  });

  it('refuses a rate that is not a non-negative integer', () => {
    expect(() => zkPaymentFee(100n, -1)).toThrow(RangeError);
    expect(() => zkPaymentFee(100n, 1.5)).toThrow(RangeError);
  });
});

describe('splitZkPayment', () => {
  it('splits a gross amount into net + fee that add back up', () => {
    const split = splitZkPayment('100', ZK_PAYMENT_FEE_BPS);
    expect(split).toEqual({
      amountStroops: 1_000_000_000n,
      feeStroops: 100_000n,
      netStroops: 999_900_000n,
      amount: '100',
      feeAmount: '0.01',
      netAmount: '99.99',
    });
  });

  it('formats every figure as a trimmed decimal string', () => {
    const split = splitZkPayment('25.5000000', ZK_PAYMENT_FEE_BPS)!;
    // 255,000,000 stroops -> fee 25,500 stroops.
    expect(split.amount).toBe('25.5');
    expect(split.feeAmount).toBe('0.00255');
    expect(split.netAmount).toBe('25.49745');
    expect(split.netStroops + split.feeStroops).toBe(split.amountStroops);
  });

  it('applies the one-stroop floor to small amounts', () => {
    const split = splitZkPayment('0.0001', ZK_PAYMENT_FEE_BPS)!;
    expect(split.feeStroops).toBe(1n);
    expect(split.netAmount).toBe('0.0000999');
  });

  it('refuses an amount whose net would be zero or less', () => {
    // One stroop gross: the whole of it would be the fee.
    expect(splitZkPayment('0.0000001', ZK_PAYMENT_FEE_BPS)).toBeNull();
    expect(splitZkPayment('0', ZK_PAYMENT_FEE_BPS)).toBeNull();
  });

  it('keeps two stroops payable: one to the merchant, one to the fee', () => {
    const split = splitZkPayment('0.0000002', ZK_PAYMENT_FEE_BPS)!;
    expect(split.netStroops).toBe(1n);
    expect(split.feeStroops).toBe(1n);
  });

  it('throws on an amount with more than 7 decimal places', () => {
    expect(() => splitZkPayment('1.00000001', ZK_PAYMENT_FEE_BPS)).toThrow(
      RangeError,
    );
  });
});
