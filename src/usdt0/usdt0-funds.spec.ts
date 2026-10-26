import { ApiError } from '@/common/errors/api-error';
import { assertCanPayXlm, assertHoldsUsdt0 } from '@/usdt0/usdt0-funds';
import { USDT0_ISSUER } from '@/usdt0/usdt0.constants';

const HOLDER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const usdt0 = (balance: string, selling = '0') => ({
  asset_type: 'credit_alphanum12',
  asset_code: 'USDT0',
  asset_issuer: USDT0_ISSUER,
  balance,
  selling_liabilities: selling,
});
const xlm = (balance: string, selling = '0') => ({
  asset_type: 'native',
  balance,
  selling_liabilities: selling,
});

function refusal(fn: () => void): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.getResponse() as { message: string };
      return { code: err.code, message: body.message };
    }
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('assertHoldsUsdt0', () => {
  it('passes when the spendable balance covers what the OFT takes', () => {
    expect(() =>
      assertHoldsUsdt0([usdt0('12.5000001')], HOLDER, 125_000_000n),
    ).not.toThrow();
  });

  it('refuses an account without the trustline', () => {
    const r = refusal(() =>
      assertHoldsUsdt0(
        [xlm('100'), { ...usdt0('50'), asset_issuer: 'GBOTHER' }],
        HOLDER,
        1n,
      ),
    );
    expect(r.code).toBe('trustline_missing');
    expect(r.message).toContain(`USDT0:${USDT0_ISSUER}`);
  });

  it('refuses a balance too small, counting what open offers hold', () => {
    const r = refusal(() =>
      assertHoldsUsdt0([usdt0('20', '15')], HOLDER, 100_000_000n),
    );
    expect(r.code).toBe('insufficient_balance');
    expect(r.message).toBe(
      `Account ${HOLDER} can send 5 USDT0 (15 of its 20 are held by its ` +
        'open offers), but this transfer takes 10.',
    );
  });
});

describe('assertCanPayXlm', () => {
  // Two subentries (the USDT0 trustline and one more): minimum 2 XLM.
  const account = { subentry_count: 2 };
  const spend = {
    address: HOLDER,
    nativeFeeLimit: 42_474_009n,
    networkFee: 14_522_490n,
  };

  it('passes when the balance covers the reserve, both fees and offers', () => {
    // 2 + 4.2474009 + 1.452249 = 7.6996499
    expect(() =>
      assertCanPayXlm(account, [xlm('7.6996499')], spend),
    ).not.toThrow();
  });

  it('refuses, saying how much XLM to add', () => {
    const r = refusal(() => assertCanPayXlm(account, [xlm('5', '1')], spend));
    expect(r.code).toBe('insufficient_balance');
    expect(r.message).toBe(
      `Account ${HOLDER} cannot pay this transfer's fees in XLM: it needs ` +
        '8.6996499 XLM (its minimum balance of 2 XLM, 1 XLM held by its open ' +
        'offers, the 4.2474009 XLM LayerZero fee limit, the 1.452249 XLM ' +
        'network fee) but holds 5 XLM. Add at least 3.6996499 XLM to it, then ' +
        'try again. What LayerZero does not charge of its fee limit comes ' +
        'back in the same transaction.',
    );
  });

  it('counts sponsorships as the network does', () => {
    // Two subentries, both sponsored by another account: minimum 1 XLM.
    expect(() =>
      assertCanPayXlm(
        { subentry_count: 2, num_sponsored: 2 },
        [xlm('6.6996499')],
        spend,
      ),
    ).not.toThrow();
  });
});
