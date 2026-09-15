import { HttpStatus } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { resolveAsset } from '@/stellar/asset';
import { BASE_RESERVE_STROOPS } from '@/stellar/stellar.constants';
import { fromStroops, toStroops } from '@/swaps/swap-math';

/**
 * `assertCanAfford` used to be private to the liquidity-pools service and was
 * only ever exercised through a whole deposit or withdrawal. The reserve
 * arithmetic is protocol, so it is pinned here to the stroop.
 */
describe('StellarAccountLoader.assertCanAfford', () => {
  const ISSUER = Keypair.random().publicKey();
  const loader = new StellarAccountLoader({} as never);
  const xlm = resolveAsset('native');
  const usdc = resolveAsset('USDC', ISSUER);
  const FEE = 200n;

  function balances(lumens: string, usdcBalance?: string) {
    return [
      { asset_type: 'native', balance: lumens },
      ...(usdcBalance === undefined
        ? []
        : [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: ISSUER,
              balance: usdcBalance,
            },
          ]),
    ];
  }

  function refusal(fn: () => void): ApiError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      return err as ApiError;
    }
    throw new Error('expected assertCanAfford to refuse');
  }

  it('prices the base reserve at half a lumen', () => {
    expect(BASE_RESERVE_STROOPS).toBe(toStroops('0.5'));
  });

  it('lets XLM cover the requirement, the reserve and the fee to the stroop', () => {
    // One subentry: (2 + 1) × 0.5 XLM of reserve, 200 stroops of fee, 10 XLM.
    const account = { subentry_count: 1 };
    const sides = [{ asset: xlm, required: toStroops('10') }];

    expect(() =>
      loader.assertCanAfford(account, balances('11.50002'), sides, false, FEE),
    ).not.toThrow();

    const err = refusal(() =>
      loader.assertCanAfford(
        account,
        balances('11.5000199'),
        sides,
        false,
        FEE,
      ),
    );
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.InsufficientBalance);
    expect(err.message).toBe(
      `Insufficient XLM balance: need ${fromStroops(toStroops('10'))} plus ` +
        `~${fromStroops(toStroops('1.5') + FEE)} XLM reserve + network fee, ` +
        `but the account holds ${fromStroops(toStroops('11.5000199'))} XLM`,
    );
  });

  it('counts a trustline the operation adds as one more subentry', () => {
    const account = { subentry_count: 1 };
    const sides = [{ asset: xlm, required: toStroops('10') }];

    expect(() =>
      loader.assertCanAfford(account, balances('11.50002'), sides, true, FEE),
    ).toThrow(ApiError);
    expect(() =>
      loader.assertCanAfford(account, balances('12.00002'), sides, true, FEE),
    ).not.toThrow();
  });

  it('reads an account without a subentry count as having none', () => {
    // Two base reserves (1 XLM) plus the fee.
    expect(() =>
      loader.assertCanAfford({}, balances('1.00002'), [], false, FEE),
    ).not.toThrow();
    expect(() =>
      loader.assertCanAfford({}, balances('1.0000199'), [], false, FEE),
    ).toThrow(ApiError);
  });

  it('checks each issued asset against its own trustline balance', () => {
    const account = { subentry_count: 1 };
    const sides = [{ asset: usdc, required: toStroops('100') }];

    expect(() =>
      loader.assertCanAfford(account, balances('10', '100'), sides, false, FEE),
    ).not.toThrow();

    const err = refusal(() =>
      loader.assertCanAfford(
        account,
        balances('10', '99.9999999'),
        sides,
        false,
        FEE,
      ),
    );
    expect(err.code).toBe(ApiErrorCode.InsufficientBalance);
    expect(err.message).toBe(
      `Insufficient USDC balance: need ${fromStroops(toStroops('100'))}, ` +
        `but the account holds ${fromStroops(toStroops('99.9999999'))}`,
    );
  });

  it('treats a missing trustline as a zero balance', () => {
    expect(() =>
      loader.assertCanAfford(
        { subentry_count: 1 },
        balances('10'),
        [{ asset: usdc, required: 1n }],
        false,
        FEE,
      ),
    ).toThrow(ApiError);
  });

  it('reports the XLM shortfall before an issued-asset one', () => {
    const err = refusal(() =>
      loader.assertCanAfford(
        { subentry_count: 1 },
        balances('1', '0'),
        [{ asset: usdc, required: 1n }],
        false,
        FEE,
      ),
    );
    expect(err.message).toMatch(/^Insufficient XLM balance/);
  });
});
