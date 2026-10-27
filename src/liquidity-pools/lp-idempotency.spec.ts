import { Keypair } from '@stellar/stellar-sdk';
import {
  DepositRequestTerms,
  StoredLiquidityTerms,
  WithdrawRequestTerms,
  liquidityOperationMatchesRequest,
} from '@/liquidity-pools/lp-idempotency';

const SOURCE = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const POOL_ID = 'dd'.repeat(32);
const FEE_WALLET = Keypair.random().publicKey();
/** 1% of each asset, out of the deposit. */
const FEE_TERMS = {
  bps: 100,
  fixed: 0n,
  wallet: FEE_WALLET,
  paidBy: 'recipient' as const,
};
/** What a deposit of 1000 native + 100 USDC with {@link FEE_TERMS} stores. */
const FEE_RECORD = {
  bps: 100,
  fixed: '0',
  amount: '10',
  asset: 'native',
  amountB: '1',
  assetB: 'USDC',
  wallet: FEE_WALLET,
  paidBy: 'recipient',
};

function storedDeposit(
  overrides: Partial<StoredLiquidityTerms> = {},
): StoredLiquidityTerms {
  return {
    kind: 'DEPOSIT',
    network: 'testnet',
    source: SOURCE,
    poolId: POOL_ID,
    assetA: 'native',
    assetAIssuer: null,
    assetB: 'USDC',
    assetBIssuer: ISSUER,
    amountA: '1000',
    amountB: '100',
    shares: null,
    slippageBps: 50,
    memo: null,
    merchantFee: null,
    ...overrides,
  };
}

function storedWithdraw(
  overrides: Partial<StoredLiquidityTerms> = {},
): StoredLiquidityTerms {
  return storedDeposit({
    kind: 'WITHDRAW',
    amountA: '990',
    amountB: '99',
    shares: '50',
    ...overrides,
  });
}

function deposit(
  overrides: Partial<DepositRequestTerms> = {},
): DepositRequestTerms {
  return {
    kind: 'DEPOSIT',
    network: 'testnet',
    source: SOURCE,
    poolId: POOL_ID,
    assetA: 'native',
    assetAIssuer: null,
    assetB: 'USDC',
    assetBIssuer: ISSUER,
    amountA: '1000',
    amountB: '100',
    slippageBps: 50,
    memo: null,
    merchantFee: null,
    ...overrides,
  };
}

function withdraw(
  overrides: Partial<WithdrawRequestTerms> = {},
): WithdrawRequestTerms {
  return {
    kind: 'WITHDRAW',
    network: 'testnet',
    source: SOURCE,
    poolId: POOL_ID,
    shares: '50',
    slippageBps: 50,
    memo: null,
    merchantFee: null,
    ...overrides,
  };
}

describe('liquidityOperationMatchesRequest', () => {
  describe('withdraw', () => {
    it('matches the request that built the operation', () => {
      expect(
        liquidityOperationMatchesRequest(storedWithdraw(), withdraw()),
      ).toBe(true);
    });

    it('compares shares by value, not by spelling', () => {
      expect(
        liquidityOperationMatchesRequest(
          storedWithdraw({ shares: '50' }),
          withdraw({ shares: '50.0000000' }),
        ),
      ).toBe(true);
    });

    it.each<[string, Partial<WithdrawRequestTerms>]>([
      ['source', { source: OTHER }],
      ['pool', { poolId: 'ee'.repeat(32) }],
      ['network', { network: 'public' }],
      ['share amount', { shares: '0.0000001' }],
      ['slippage', { slippageBps: 500 }],
      ['memo', { memo: '7' }],
    ])('refuses a different %s', (_field, change) => {
      expect(
        liquidityOperationMatchesRequest(storedWithdraw(), withdraw(change)),
      ).toBe(false);
    });

    it('refuses to answer a withdraw with a deposit stored under the same key', () => {
      // The key index does not tell the two kinds apart, so this used to replay.
      expect(
        liquidityOperationMatchesRequest(storedDeposit(), withdraw()),
      ).toBe(false);
    });
  });

  describe('deposit', () => {
    it('matches the request that built the operation', () => {
      expect(liquidityOperationMatchesRequest(storedDeposit(), deposit())).toBe(
        true,
      );
    });

    it.each<[string, Partial<DepositRequestTerms>]>([
      ['source', { source: OTHER }],
      ['pool', { poolId: 'ee'.repeat(32) }],
      ['network', { network: 'public' }],
      ['first asset', { assetA: 'EURC', assetAIssuer: ISSUER }],
      ['second asset issuer', { assetBIssuer: OTHER }],
      ['first amount', { amountA: '999' }],
      ['second amount', { amountB: '100.0000001' }],
      ['slippage', { slippageBps: 500 }],
      ['memo', { memo: '7' }],
    ])('refuses a different %s', (_field, change) => {
      expect(
        liquidityOperationMatchesRequest(storedDeposit(), deposit(change)),
      ).toBe(false);
    });

    it('does not compare a side the caller left for the pool price to fill', () => {
      // That side was derived from the reserves when the row was built. A retry
      // of the same one-sided request after the reserves moved must replay.
      expect(
        liquidityOperationMatchesRequest(
          storedDeposit({ amountB: '101.5' }),
          deposit({ amountB: null }),
        ),
      ).toBe(true);
    });

    it('still compares the side the caller did give', () => {
      expect(
        liquidityOperationMatchesRequest(
          storedDeposit(),
          deposit({ amountA: '5', amountB: null }),
        ),
      ).toBe(false);
    });
  });

  describe('with a merchant fee', () => {
    it('compares a deducted fee against the amounts the caller asked for, not the caps', () => {
      // The caps are 990 / 99: the fee came out of 1000 / 100.
      const stored = storedDeposit({
        amountA: '990',
        amountB: '99',
        merchantFee: FEE_RECORD,
      });
      expect(
        liquidityOperationMatchesRequest(
          stored,
          deposit({ merchantFee: FEE_TERMS }),
        ),
      ).toBe(true);
      expect(
        liquidityOperationMatchesRequest(
          stored,
          deposit({ amountA: '990', merchantFee: FEE_TERMS }),
        ),
      ).toBe(false);
    });

    it('compares a fee paid on top against the caps themselves', () => {
      const onTop = { ...FEE_TERMS, paidBy: 'payer' as const };
      expect(
        liquidityOperationMatchesRequest(
          storedDeposit({
            merchantFee: { ...FEE_RECORD, paidBy: 'payer' },
          }),
          deposit({ merchantFee: onTop }),
        ),
      ).toBe(true);
    });

    it('never matches a request with another fee, or none', () => {
      const stored = storedWithdraw({ merchantFee: FEE_RECORD });
      expect(
        liquidityOperationMatchesRequest(
          stored,
          withdraw({ merchantFee: FEE_TERMS }),
        ),
      ).toBe(true);
      expect(liquidityOperationMatchesRequest(stored, withdraw())).toBe(false);
      expect(
        liquidityOperationMatchesRequest(
          stored,
          withdraw({ merchantFee: { ...FEE_TERMS, bps: 200 } }),
        ),
      ).toBe(false);
      expect(
        liquidityOperationMatchesRequest(
          storedWithdraw(),
          withdraw({ merchantFee: FEE_TERMS }),
        ),
      ).toBe(false);
    });
  });

  // `undefined` is what the service hands over for a row whose memo column is
  // null and whose envelope it could not read.
  it('matches nothing when the stored memo could not be established', () => {
    expect(
      liquidityOperationMatchesRequest(
        storedWithdraw({ memo: undefined }),
        withdraw(),
      ),
    ).toBe(false);
  });
});
