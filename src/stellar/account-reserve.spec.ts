import {
  minimumBalanceStroops,
  nativeBalanceStroops,
  nativeSellingLiabilitiesStroops,
} from '@/stellar/account-reserve';
import { toStroops } from '@/swaps/swap-math';

/**
 * The minimum balance is protocol (`(2 + subentries + sponsoring - sponsored) ×
 * base reserve`, CAP-33), and the trustline a transaction adds is priced on top
 * of it, so it is pinned here in lumens.
 */
describe('minimumBalanceStroops', () => {
  it('is two base reserves for an account with nothing on it', () => {
    expect(minimumBalanceStroops({})).toBe(toStroops('1'));
    expect(
      minimumBalanceStroops({
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
      }),
    ).toBe(toStroops('1'));
  });

  it('adds a base reserve per subentry, and one per trustline being added', () => {
    expect(minimumBalanceStroops({ subentry_count: 3 })).toBe(toStroops('2.5'));
    expect(minimumBalanceStroops({ subentry_count: 3 }, 1n)).toBe(
      toStroops('3'),
    );
  });

  it('charges entries the account sponsors and frees the ones sponsored for it', () => {
    // 2 + 4 subentries + 2 it sponsors - 3 sponsored for it = 5 reserves.
    expect(
      minimumBalanceStroops({
        subentry_count: 4,
        num_sponsoring: 2,
        num_sponsored: 3,
      }),
    ).toBe(toStroops('2.5'));
  });
});

describe('native balance lines', () => {
  const balances = [
    {
      asset_type: 'credit_alphanum4',
      balance: '50',
      selling_liabilities: '7',
    },
    { asset_type: 'native', balance: '12.5', selling_liabilities: '2.25' },
  ];

  it('reads the XLM line, not the first one', () => {
    expect(nativeBalanceStroops(balances)).toBe(toStroops('12.5'));
    expect(nativeSellingLiabilitiesStroops(balances)).toBe(toStroops('2.25'));
  });

  it('reads a missing line or field as zero', () => {
    expect(nativeBalanceStroops([])).toBe(0n);
    expect(
      nativeSellingLiabilitiesStroops([{ asset_type: 'native', balance: '1' }]),
    ).toBe(0n);
  });
});
