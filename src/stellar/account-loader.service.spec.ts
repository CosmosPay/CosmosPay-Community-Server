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

describe('StellarAccountLoader.assertCanAfford with sponsorships and offers', () => {
  const loader = new StellarAccountLoader({} as never);
  const xlm = resolveAsset('native');

  it('prices sponsorships and keeps what open offers hold out of reach', () => {
    // (2 + 1 subentry + 2 sponsoring - 1 sponsored) x 0.5 = 2 XLM reserve, plus
    // 3 XLM held by offers and 200 stroops of fee, before the 10 XLM it spends.
    const account = { subentry_count: 1, num_sponsoring: 2, num_sponsored: 1 };
    const sides = [{ asset: xlm, required: toStroops('10') }];
    const lumens = (balance: string) => [
      { asset_type: 'native', balance, selling_liabilities: '3' },
    ];

    expect(() =>
      loader.assertCanAfford(account, lumens('15.00002'), sides, false, 200n),
    ).not.toThrow();
    expect(() =>
      loader.assertCanAfford(account, lumens('15.0000199'), sides, false, 200n),
    ).toThrow(ApiError);
  });
});

describe('StellarAccountLoader trustline rules', () => {
  const ISSUER = Keypair.random().publicKey();
  const HOLDER = Keypair.random().publicKey();
  const loader = new StellarAccountLoader({} as never);
  const usdc = resolveAsset('USDC', ISSUER);
  const trusting = [
    { asset_type: 'native', balance: '5' },
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      balance: '0',
    },
  ];
  const lumensOnly = [{ asset_type: 'native', balance: '5' }];

  describe('hasTrustline', () => {
    it('needs no trustline for lumens', () => {
      expect(loader.hasTrustline([], resolveAsset('native'))).toBe(true);
    });

    it('finds the line by code and issuer', () => {
      expect(loader.hasTrustline(trusting, usdc)).toBe(true);
      expect(loader.hasTrustline(lumensOnly, usdc)).toBe(false);
      expect(
        loader.hasTrustline(
          trusting,
          resolveAsset('USDC', Keypair.random().publicKey()),
        ),
      ).toBe(false);
    });

    it('counts the issuer as able to hold its own asset, but only when it is named', () => {
      expect(loader.hasTrustline(lumensOnly, usdc, ISSUER)).toBe(true);
      expect(loader.hasTrustline(lumensOnly, usdc, HOLDER)).toBe(false);
    });
  });

  describe('assertCanReceive', () => {
    it('lets an account that trusts the asset, or issues it, receive it', () => {
      expect(() =>
        loader.assertCanReceive(trusting, usdc, HOLDER, 'the swap'),
      ).not.toThrow();
      expect(() =>
        loader.assertCanReceive(lumensOnly, usdc, ISSUER, 'the swap'),
      ).not.toThrow();
    });

    it('refuses with trustline_missing, saying only that account can add it', () => {
      let err: ApiError | undefined;
      try {
        loader.assertCanReceive(lumensOnly, usdc, HOLDER, 'this payment');
      } catch (e) {
        err = e as ApiError;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err!.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err!.code).toBe(ApiErrorCode.TrustlineMissing);
      expect(err!.message).toBe(
        `Account ${HOLDER} has no trustline for USDC:${ISSUER}, so it cannot ` +
          'receive this payment. Only that account can add the trustline, by ' +
          'signing a transaction of its own: ask its owner to add it, then try again.',
      );
    });
  });

  describe('assertCanAddTrustline', () => {
    const FEE = 300n;

    function refusal(fn: () => void): ApiError {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        return err as ApiError;
      }
      throw new Error('expected assertCanAddTrustline to refuse');
    }

    it('fits the new reserve, what the transaction sends and the fee to the stroop', () => {
      // No subentries yet: (2 + 1) x 0.5 = 1.5 XLM once the trustline exists,
      // plus 10 XLM sent and 300 stroops of fee.
      const check = {
        address: HOLDER,
        asset: usdc,
        nativeSpent: toStroops('10'),
        txFee: FEE,
      };

      expect(() =>
        loader.assertCanAddTrustline(
          { subentry_count: 0 },
          [{ asset_type: 'native', balance: '11.50003' }],
          check,
        ),
      ).not.toThrow();

      const err = refusal(() =>
        loader.assertCanAddTrustline(
          { subentry_count: 0 },
          [{ asset_type: 'native', balance: '11.5000299' }],
          check,
        ),
      );
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err.code).toBe(ApiErrorCode.InsufficientBalance);
      expect(err.message).toBe(
        `Account ${HOLDER} cannot pay for the USDC trustline this transaction ` +
          'adds: a trustline locks another 0.5 XLM of its balance, so it needs ' +
          '11.50003 XLM (its new minimum balance of 1.5 XLM, the 10 XLM it ' +
          'sends, the 0.00003 XLM network fee) but holds 11.5000299 XLM. Add ' +
          'at least 0.0000001 XLM to it, then try again.',
      );
    });

    it('leaves out what the transaction does not spend in lumens', () => {
      const err = refusal(() =>
        loader.assertCanAddTrustline(
          { subentry_count: 0 },
          [{ asset_type: 'native', balance: '1' }],
          { address: HOLDER, asset: usdc, nativeSpent: 0n, txFee: FEE },
        ),
      );
      expect(err.message).toContain(
        '(its new minimum balance of 1.5 XLM, the 0.00003 XLM network fee)',
      );
    });

    it('counts sponsorships and open offers like the network does', () => {
      // (2 + 2 + 1 - 2 + 1) x 0.5 = 2 XLM, plus 0.5 XLM held by offers and
      // the fee: 2.50003 XLM.
      const account = {
        subentry_count: 2,
        num_sponsoring: 1,
        num_sponsored: 2,
      };
      const lumens = (balance: string) => [
        { asset_type: 'native', balance, selling_liabilities: '0.5' },
      ];
      const check = {
        address: HOLDER,
        asset: usdc,
        nativeSpent: 0n,
        txFee: FEE,
      };

      expect(() =>
        loader.assertCanAddTrustline(account, lumens('2.50003'), check),
      ).not.toThrow();
      const err = refusal(() =>
        loader.assertCanAddTrustline(account, lumens('2.5'), check),
      );
      expect(err.message).toContain('0.5 XLM held by its open offers');
    });
  });
});
