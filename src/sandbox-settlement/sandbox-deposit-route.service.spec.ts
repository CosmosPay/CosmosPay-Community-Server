import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { addressOfSecretKey } from '@/evm/evm-transaction';
import { SandboxDepositRoute } from '@/sandbox-settlement/sandbox-deposit-route.service';
import {
  depositSecretKey,
  parseDepositPath,
} from '@/sandbox-settlement/sandbox-hd';
import { sandboxAmountIn } from '@/sandbox-settlement/sandbox-quote';

const SEED = '0x' + '42'.repeat(32);
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER = '0x' + '1'.repeat(40);
const CUSD_BSC = '0x' + 'c'.repeat(40);

function build(sandbox: Record<string, unknown> = {}) {
  const values = {
    sandbox: {
      depositSeed: SEED,
      treasuryPrivateKey: '0x' + '07'.repeat(32),
      rpcUrls: {},
      cusdAddresses: {},
      timeoutMs: 1000,
      ...sandbox,
    },
  };
  return new SandboxDepositRoute({
    get: (key: keyof typeof values) => values[key],
  } as never);
}

const LINK = {
  chain: 'base',
  network: 'testnet',
  destination: MERCHANT,
  amount: '25',
  asset: 'USDC',
  assetIssuer: BASE_SEPOLIA_USDC,
  assetDecimals: 6,
  merchantFee: null,
  crossChainFeeBps: 0,
};

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('SandboxDepositRoute', () => {
  it('reaches no network until both secrets are set, and says so', () => {
    const route = build({ depositSeed: '' });
    expect(route.isConfigured()).toBe(false);
    const base = route.availability('base');
    expect(base.available).toBe(false);
    expect(base.reason).toMatch(/not set up/);
    expect(route.payableAssets()).toEqual([]);
  });

  it('reaches the EVM test networks with Circle test USDC, and cUSD ones once deployed', () => {
    const route = build();
    expect(route.availability('base')).toMatchObject({
      available: true,
      asset: { symbol: 'USDC', contract: BASE_SEPOLIA_USDC, decimals: 6 },
    });
    const bsc = route.availability('bsc');
    expect(bsc.available).toBe(false);
    expect(bsc.reason).toMatch(/cUSD.*not deployed/);
    expect(
      build({ cusdAddresses: { bsc: CUSD_BSC } }).availability('bsc'),
    ).toMatchObject({
      available: true,
      asset: { symbol: 'cUSD', contract: CUSD_BSC },
    });
  });

  it('keeps the other networks off, with the reason', () => {
    const route = build();
    for (const id of ['btc', 'tron', 'abs', 'hypercore'] as const) {
      const a = route.availability(id);
      expect(a.available).toBe(false);
      expect(a.reason).toBeTruthy();
      expect(a.reason).not.toMatch(/near intents|1click/i);
    }
    expect(route.catalog()).toHaveLength(35);
  });

  it('takes only the test stablecoin, from the payer and for a link', () => {
    const route = build();
    expect(route.originAsset('eth', 'usdc').chain).toBe('eth');
    expect(
      route.originAsset('eth', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238')
        .symbol,
    ).toBe('USDC');
    expect(refusal(() => route.originAsset('eth', 'ETH')).code).toBe(
      ApiErrorCode.AssetUnsupported,
    );
    expect(refusal(() => route.originAsset('btc', 'BTC')).code).toBe(
      ApiErrorCode.AssetUnsupported,
    );
    expect(route.linkAssetForCreate('base', undefined, undefined).symbol).toBe(
      'USDC',
    );
    expect(
      refusal(() => route.linkAssetForCreate('base', 'ETH', undefined)).code,
    ).toBe(ApiErrorCode.AssetUnsupported);
    expect(
      refusal(() => route.linkAssetForCreate('tron', 'USDT', undefined)).code,
    ).toBe(ApiErrorCode.NetworkUnsupported);
  });

  it('prices one for one, with no commission, and a dry quote opens no address', () => {
    const priced = build().price(
      LINK,
      { originChain: 'arb', originAsset: 'USDC', refundTo: PAYER },
      false,
    );
    expect(priced).toMatchObject({
      amountIn: '25',
      minAmountIn: '25',
      amountOut: '25',
      feeBps: 0,
      feeAmount: '0',
      recipient: MERCHANT,
    });
    expect(priced.response.quote.depositAddress).toBeUndefined();
  });

  it('opens a live deposit address derived from the seed, its path kept', () => {
    const priced = build().price(
      LINK,
      { originChain: 'eth', originAsset: 'USDC', refundTo: PAYER },
      true,
    );
    const path = priced.response.correlationId.replace(/^sandbox:/, '');
    const indexes = parseDepositPath(path);
    expect(indexes).not.toBeNull();
    expect(priced.response.quote.depositAddress).toBe(
      addressOfSecretKey(depositSecretKey(SEED, indexes!)),
    );
    expect(priced.response.quote.deadline).toBeDefined();
  });

  it('quotes what the payer typed on a link without an amount', () => {
    const open = { ...LINK, amount: null };
    const priced = build().price(
      open,
      {
        originChain: 'arb',
        originAsset: 'USDC',
        refundTo: PAYER,
        amount: '7.5',
      },
      false,
    );
    expect(priced).toMatchObject({ amountIn: '7.5', amountOut: '7.5' });
    expect(priced.request.amount).toBe('7500000');
    expect(
      refusal(() =>
        build().price(
          open,
          { originChain: 'arb', originAsset: 'USDC', refundTo: PAYER },
          false,
        ),
      ).code,
    ).toBe(ApiErrorCode.ValidationFailed);
  });

  it('refuses a link with a merchant fee, which it does not settle yet', () => {
    const err = refusal(() =>
      build().price(
        {
          ...LINK,
          merchantFee: {
            bps: 100,
            fixed: '0',
            amount: '0.25',
            asset: 'USDC',
            wallet: '0x' + '9'.repeat(40),
            paidBy: 'recipient',
          },
        },
        { originChain: 'arb', originAsset: 'USDC', refundTo: PAYER },
        false,
      ),
    );
    expect(err.code).toBe(ApiErrorCode.MerchantFeeUnsupported);
    expect(err.message).not.toMatch(/near|1click/i);
  });

  it('writes the same value in the origin decimals, rounding up', () => {
    expect(sandboxAmountIn('25', { decimals: 6 }, { decimals: 18 })).toBe('25');
    expect(sandboxAmountIn('1.000001', { decimals: 6 }, { decimals: 6 })).toBe(
      '1.000001',
    );
    expect(
      sandboxAmountIn('0.123456789', { decimals: 18 }, { decimals: 6 }),
    ).toBe('0.123457');
  });
});
