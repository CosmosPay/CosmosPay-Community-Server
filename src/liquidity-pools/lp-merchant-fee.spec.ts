import { Keypair } from '@stellar/stellar-sdk';
import { ApiError } from '@/common/errors/api-error';
import {
  liquidityMerchantFee,
  liquidityMerchantFeeRecord,
  readLiquidityMerchantFee,
  resolveLiquidityMerchantFee,
} from '@/liquidity-pools/lp-merchant-fee';

const WALLET = Keypair.random().publicKey();

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  return undefined;
};

describe('the liquidity merchant fee', () => {
  it('takes a percentage and refuses a fixed part, which has no single asset', () => {
    expect(resolveLiquidityMerchantFee({ bps: 100, wallet: WALLET })).toEqual({
      bps: 100,
      fixed: 0n,
      wallet: WALLET,
      paidBy: 'recipient',
    });
    expect(
      codeOf(() =>
        resolveLiquidityMerchantFee({ bps: 100, fixed: '1', wallet: WALLET }),
      ),
    ).toBe('validation_failed');
    expect(resolveLiquidityMerchantFee(undefined)).toBeNull();
  });

  it('charges each asset its share, rounded down', () => {
    const terms = resolveLiquidityMerchantFee({ bps: 150, wallet: WALLET })!;
    // 1.5% of 1,000 and of 99 stroops: 15 and 1.485 -> 1.
    expect(liquidityMerchantFee(terms, 1_000n, 99n)).toEqual({
      feeA: 15n,
      feeB: 1n,
    });
    // One side may round to nothing; it then has no payment.
    expect(liquidityMerchantFee(terms, 1_000n, 10n)).toEqual({
      feeA: 15n,
      feeB: 0n,
    });
  });

  it('refuses a fee that charges nothing on either asset', () => {
    const terms = resolveLiquidityMerchantFee({ bps: 1, wallet: WALLET })!;
    expect(codeOf(() => liquidityMerchantFee(terms, 9_999n, 100n))).toBe(
      'invalid_amount',
    );
  });

  it('keeps both legs in its record and reads them back', () => {
    const terms = resolveLiquidityMerchantFee({
      bps: 100,
      wallet: WALLET,
      paidBy: 'payer',
    })!;
    const record = liquidityMerchantFeeRecord(
      terms,
      { feeA: 100_000_000n, feeB: 10_000_000n },
      'native',
      'USDC',
    );
    expect(record).toEqual({
      bps: 100,
      fixed: '0',
      amount: '10',
      asset: 'native',
      amountB: '1',
      assetB: 'USDC',
      wallet: WALLET,
      paidBy: 'payer',
    });
    expect(readLiquidityMerchantFee(record)).toEqual(record);
    // A record without asset B's leg is not a liquidity record.
    const { amountB: _b, assetB: _a, ...single } = record;
    expect(readLiquidityMerchantFee(single)).toBeNull();
    expect(readLiquidityMerchantFee(null)).toBeNull();
  });
});
