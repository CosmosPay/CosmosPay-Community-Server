import { ApiError } from '@/common/errors/api-error';
import type { MerchantFeeTerms } from '@/common/merchant-fee/merchant-fee';
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
      feeStroops: 1_800_000n,
      netStroops: 998_200_000n,
      merchantFeeStroops: 0n,
      amount: '100',
      feeAmount: '0.18',
      netAmount: '99.82',
    });
  });

  it('formats every figure as a trimmed decimal string', () => {
    const split = splitZkPayment('25.5000000', ZK_PAYMENT_FEE_BPS)!;
    // 255,000,000 stroops -> fee 459,000 stroops.
    expect(split.amount).toBe('25.5');
    expect(split.feeAmount).toBe('0.0459');
    expect(split.netAmount).toBe('25.4541');
    expect(split.netStroops + split.feeStroops).toBe(split.amountStroops);
  });

  it('applies the one-stroop floor to small amounts', () => {
    // 500 stroops at 18 bps is 0.9 of a stroop.
    const split = splitZkPayment('0.00005', ZK_PAYMENT_FEE_BPS)!;
    expect(split.feeStroops).toBe(1n);
    expect(split.netAmount).toBe('0.0000499');
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

  describe('with a merchant fee', () => {
    const WALLET = 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI';
    // 1.5% plus 0.25 XLM.
    const fee: MerchantFeeTerms = {
      bps: 150,
      fixed: 2_500_000n,
      wallet: WALLET,
      paidBy: 'recipient',
    };

    it('takes it from the amount when the recipient pays it', () => {
      const split = splitZkPayment('100', ZK_PAYMENT_FEE_BPS, fee)!;
      // 1.5 + 0.25 = 1.75 XLM; the commission stays 0.18% of 100.
      expect(split.merchantFeeStroops).toBe(17_500_000n);
      expect(split.amount).toBe('100');
      expect(split.feeAmount).toBe('0.18');
      expect(split.netAmount).toBe('98.07');
      expect(
        split.netStroops + split.feeStroops + split.merchantFeeStroops,
      ).toBe(split.amountStroops);
    });

    it('adds it on top when the payer pays it', () => {
      const split = splitZkPayment('100', ZK_PAYMENT_FEE_BPS, {
        ...fee,
        paidBy: 'payer',
      })!;
      expect(split.amount).toBe('101.75');
      expect(split.netAmount).toBe('99.82');
      expect(
        split.netStroops + split.feeStroops + split.merchantFeeStroops,
      ).toBe(split.amountStroops);
    });

    it('refuses a fee that charges nothing or takes everything', () => {
      const codeOf = (run: () => unknown) => {
        try {
          run();
        } catch (err) {
          if (err instanceof ApiError) return err.code;
          throw err;
        }
        return undefined;
      };
      // 1.5% of one stroop rounds to zero.
      expect(
        codeOf(() =>
          splitZkPayment('0.0000001', ZK_PAYMENT_FEE_BPS, {
            ...fee,
            fixed: 0n,
          }),
        ),
      ).toBe('invalid_amount');
      // A fixed 0.25 XLM out of 0.2 XLM.
      expect(codeOf(() => splitZkPayment('0.2', ZK_PAYMENT_FEE_BPS, fee))).toBe(
        'invalid_amount',
      );
    });

    it('is null when the commission takes what the merchant fee left', () => {
      // 0.25 XLM + 1 stroop: the fee leaves one stroop, the commission takes more.
      expect(
        splitZkPayment('0.2500001', ZK_PAYMENT_FEE_BPS, { ...fee, bps: 0 }),
      ).toBeNull();
    });
  });

  it('throws on an amount with more than 7 decimal places', () => {
    expect(() => splitZkPayment('1.00000001', ZK_PAYMENT_FEE_BPS)).toThrow(
      RangeError,
    );
  });
});
