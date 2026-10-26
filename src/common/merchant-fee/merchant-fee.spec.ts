import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { ApiError } from '@/common/errors/api-error';
import {
  assertMerchantFeeCovered,
  merchantFeeRecord,
  readMerchantFeeRecord,
  resolveMerchantFee,
  sameMerchantFee,
  splitMerchantFee,
} from '@/common/merchant-fee/merchant-fee';

const WALLET = 'GBDHAQXQQ75WVBUZ2IX3O7ME7JOKJUOUPUXRNDCORUJODWQCTVUEQ62R';
const STELLAR = CHAIN_ADDRESS_RULES.stellar;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : 'not-an-api-error';
  }
  return undefined;
};

describe('resolveMerchantFee', () => {
  it('is null when the request names no fee', () => {
    expect(resolveMerchantFee(undefined, 7, STELLAR)).toBeNull();
  });

  it('reads the fixed part in the asset decimals and defaults the payer to the recipient', () => {
    expect(
      resolveMerchantFee(
        { bps: 150, fixed: '0.25', wallet: WALLET },
        7,
        STELLAR,
      ),
    ).toEqual({
      bps: 150,
      fixed: 2_500_000n,
      wallet: WALLET,
      paidBy: 'recipient',
    });
  });

  it('refuses a fee of nothing, a fixed part finer than the asset and a wallet of another chain', () => {
    expect(
      codeOf(() => resolveMerchantFee({ wallet: WALLET }, 7, STELLAR)),
    ).toBe('validation_failed');
    expect(
      codeOf(() =>
        resolveMerchantFee({ fixed: '0.00000001', wallet: WALLET }, 7, STELLAR),
      ),
    ).toBe('invalid_amount');
    expect(
      codeOf(() =>
        resolveMerchantFee(
          { bps: 10, wallet: '0x8ba1f109551bD432803012645Ac136ddd64DBA72' },
          7,
          STELLAR,
        ),
      ),
    ).toBe('validation_failed');
  });

  it('refuses a percentage above the cap even when the DTO was skipped', () => {
    expect(
      codeOf(() =>
        resolveMerchantFee({ bps: 1_001, wallet: WALLET }, 7, STELLAR),
      ),
    ).toBe('validation_failed');
  });
});

describe('splitMerchantFee', () => {
  const terms = {
    bps: 150,
    fixed: 25n,
    wallet: WALLET,
    paidBy: 'recipient' as const,
  };

  it('deducts the fee from the amount when the recipient pays it', () => {
    // 1.5% of 10,000 is 150, plus 25 fixed.
    expect(splitMerchantFee(10_000n, terms)).toEqual({
      fee: 175n,
      net: 9_825n,
      total: 10_000n,
    });
  });

  it('adds the fee on top when the payer pays it', () => {
    expect(splitMerchantFee(10_000n, { ...terms, paidBy: 'payer' })).toEqual({
      fee: 175n,
      net: 10_000n,
      total: 10_175n,
    });
  });

  it('rounds the percentage down, never above the stated rate', () => {
    // 1.5% of 99 is 1.485: the payer is charged 1, not 2.
    expect(splitMerchantFee(99n, { ...terms, fixed: 0n }).fee).toBe(1n);
  });

  it('leaves the amount whole with no fee', () => {
    expect(splitMerchantFee(500n, null)).toEqual({
      fee: 0n,
      net: 500n,
      total: 500n,
    });
  });

  it('refuses a deducted fee that leaves nothing to go on', () => {
    expect(
      codeOf(() =>
        assertMerchantFeeCovered(splitMerchantFee(20n, terms), terms),
      ),
    ).toBe('invalid_amount');
    // The same fee on top always leaves the amount.
    const onTop = { ...terms, paidBy: 'payer' as const };
    expect(() =>
      assertMerchantFeeCovered(splitMerchantFee(20n, onTop), onTop),
    ).not.toThrow();
  });

  it('refuses a fee the request named that rounds to nothing', () => {
    // 1.5% of 50 base units is 0.75, rounded down to 0, and no fixed part.
    const percent = { ...terms, fixed: 0n };
    expect(
      codeOf(() =>
        assertMerchantFeeCovered(splitMerchantFee(50n, percent), percent),
      ),
    ).toBe('invalid_amount');
    // No fee at all is not a fee of zero.
    expect(() =>
      assertMerchantFeeCovered(splitMerchantFee(50n, null), null),
    ).not.toThrow();
  });
});

describe('the stored record', () => {
  const terms = {
    bps: 150,
    fixed: 2_500_000n,
    wallet: WALLET,
    paidBy: 'payer' as const,
  };
  const record = merchantFeeRecord(terms, 17_500_000n, 7, 'XLM');

  it('keeps decimals in the asset', () => {
    expect(record).toEqual({
      bps: 150,
      fixed: '0.25',
      amount: '1.75',
      asset: 'XLM',
      wallet: WALLET,
      paidBy: 'payer',
    });
    expect(readMerchantFeeRecord(JSON.parse(JSON.stringify(record)))).toEqual(
      record,
    );
  });

  it('reads nothing from a column that holds none or something else', () => {
    expect(readMerchantFeeRecord(null)).toBeNull();
    expect(readMerchantFeeRecord({ bps: 1 })).toBeNull();
    expect(readMerchantFeeRecord([record])).toBeNull();
  });

  it('matches a replay only with the same terms', () => {
    expect(sameMerchantFee(record, terms, 7)).toBe(true);
    // "0.2500000" is the same fixed part as "0.25".
    expect(sameMerchantFee({ ...record, fixed: '0.2500000' }, terms, 7)).toBe(
      true,
    );
    expect(sameMerchantFee(record, { ...terms, paidBy: 'recipient' }, 7)).toBe(
      false,
    );
    expect(sameMerchantFee(record, { ...terms, bps: 100 }, 7)).toBe(false);
    expect(sameMerchantFee(record, null, 7)).toBe(false);
    expect(sameMerchantFee(null, terms, 7)).toBe(false);
    expect(sameMerchantFee(null, null, 7)).toBe(true);
  });
});
