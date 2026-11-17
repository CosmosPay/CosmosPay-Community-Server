import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';
import { PaymentDepositPricing } from '@/payment-intents/payment-deposit-pricing.service';

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER = 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy';

const TOKENS: NearIntentsToken[] = [
  {
    assetId: `nep141:base-${BASE_USDC}.omft.near`,
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    contractAddress: BASE_USDC,
    price: 1,
  },
  {
    assetId: 'nep141:base.omft.near',
    decimals: 18,
    blockchain: 'base',
    symbol: 'ETH',
    price: 3000,
  },
  {
    assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    decimals: 6,
    blockchain: 'tron',
    symbol: 'USDT',
    contractAddress: TRON_USDT,
    price: 1,
  },
  {
    assetId: 'nep141:base-0xdead.omft.near',
    decimals: 18,
    blockchain: 'base',
    symbol: 'NOPRICE',
    contractAddress: '0x000000000000000000000000000000000000dead',
  },
];

const LINK = {
  chain: 'base',
  destination: MERCHANT,
  amount: '25',
  asset: 'USDC',
  assetIssuer: BASE_USDC,
  assetDecimals: 6,
  merchantFee: null,
  crossChainFeeBps: 50,
};

function build(feeRecipient = 'cosmospay.near') {
  const nearIntents = {
    tokens: jest.fn().mockResolvedValue(TOKENS),
    quote: jest.fn().mockImplementation((request) =>
      Promise.resolve({
        correlationId: 'corr',
        timestamp: '2026-11-16T15:00:00.000Z',
        signature: 'ed25519:sig',
        quoteRequest: request,
        quote: {
          amountIn: '25284231',
          amountInFormatted: '25.284231',
          amountInUsd: '25.27',
          minAmountIn: '25031458',
          amountOut: request.amount,
          amountOutFormatted: '25',
          amountOutUsd: '24.99',
          minAmountOut: request.amount,
          timeEstimate: 82,
          ...(request.dry
            ? {}
            : {
                depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
                deadline: '2026-11-16T15:30:00.000Z',
              }),
        },
      }),
    ),
  };
  const values: Record<string, unknown> = {
    nearIntents: {
      feeRecipient,
      slippageBps: 100,
      deadlineSeconds: 1800,
    },
    swapCommissionDevWaiver: false,
  };
  const config = { get: (key: string) => values[key] } as never;
  return {
    pricing: new PaymentDepositPricing(config, nearIntents as never),
    nearIntents,
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('PaymentDepositPricing', () => {
  it('prices an exact output: the link amount to the merchant, the commission as an app fee', async () => {
    const { pricing, nearIntents } = build();

    const priced = await pricing.price(
      LINK,
      { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
      false,
    );

    const request = nearIntents.quote.mock.calls[0][0];
    expect(request).toMatchObject({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      depositMode: 'SIMPLE',
      originAsset: TOKENS[2].assetId,
      destinationAsset: TOKENS[0].assetId,
      // 25 USDC in base units: exactly what the merchant receives.
      amount: '25000000',
      recipient: MERCHANT,
      refundTo: PAYER,
      recipientType: 'DESTINATION_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      appFees: [{ recipient: 'cosmospay.near', fee: 50 }],
    });
    expect(priced).toMatchObject({
      amountIn: '25.284231',
      minAmountIn: '25.031458',
      amountOut: '25',
      feeBps: 50,
      // 0.5% of what is deposited, in the origin asset.
      feeAmount: '0.126421',
    });
  });

  it('asks for a memo deposit when the payer sends from Stellar', async () => {
    const { pricing, nearIntents } = build();
    nearIntents.tokens.mockResolvedValueOnce([
      ...TOKENS,
      {
        assetId: 'nep245:v2_1.omni.hot.tg:1100_xlm',
        decimals: 7,
        blockchain: 'stellar',
        symbol: 'XLM',
        price: 0.3,
      },
    ]);
    await pricing.price(
      LINK,
      {
        originChain: 'stellar',
        originAsset: 'XLM',
        refundTo: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
      },
      true,
    );
    expect(nearIntents.quote.mock.calls[0][0]).toMatchObject({
      dry: false,
      depositMode: 'MEMO',
    });
  });

  it('sends no app fee when the plan charges none', async () => {
    const { pricing, nearIntents } = build();
    await pricing.price(
      { ...LINK, crossChainFeeBps: 0 },
      { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
      false,
    );
    expect(nearIntents.quote.mock.calls[0][0].appFees).toBeUndefined();
  });

  it('refuses a commission with nowhere to be collected', async () => {
    const { pricing } = build('');
    const err = await refusal(
      pricing.price(
        LINK,
        { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
        false,
      ),
    );
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
  });

  it('refuses a quote that pays the merchant less than the link amount', async () => {
    const { pricing, nearIntents } = build();
    nearIntents.quote.mockImplementationOnce((request) =>
      Promise.resolve({
        correlationId: 'corr',
        signature: 'sig',
        quoteRequest: request,
        quote: {
          amountIn: '1',
          minAmountIn: '1',
          amountOut: '24000000',
          amountOutFormatted: '24',
          minAmountOut: '24000000',
          timeEstimate: 1,
        },
      }),
    );
    const err = await refusal(
      pricing.price(
        LINK,
        { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
        false,
      ),
    );
    expect(err.code).toBe(ApiErrorCode.ProviderError);
  });

  it("refuses when the link's own asset is no longer traded", async () => {
    const { pricing } = build();
    const err = await refusal(
      pricing.price(
        {
          ...LINK,
          asset: 'NOPRICE',
          assetIssuer: '0x000000000000000000000000000000000000dead',
        },
        { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
        false,
      ),
    );
    expect(err.code).toBe(ApiErrorCode.AssetUnsupported);
  });

  describe('a link without an amount', () => {
    const open = { ...LINK, amount: null };

    it('quotes exactly what the payer typed', async () => {
      const { pricing, nearIntents } = build();
      const priced = await pricing.price(
        open,
        {
          originChain: 'tron',
          originAsset: 'USDT',
          refundTo: PAYER,
          amount: '12.5',
        },
        false,
      );
      expect(nearIntents.quote.mock.calls[0][0].amount).toBe('12500000');
      expect(priced.amountOut).toBe('12.5');
    });

    it('needs the payer to say how much, within the asset and above zero', async () => {
      const { pricing } = build();
      const ask = (amount?: string) =>
        refusal(
          pricing.price(
            open,
            {
              originChain: 'tron',
              originAsset: 'USDT',
              refundTo: PAYER,
              amount,
            },
            false,
          ),
        );
      expect((await ask()).code).toBe(ApiErrorCode.ValidationFailed);
      expect((await ask('1.0000001')).code).toBe(ApiErrorCode.InvalidAmount);
      expect((await ask('0')).code).toBe(ApiErrorCode.InvalidAmount);
    });

    it('refuses another amount on a link that has one', async () => {
      const { pricing } = build();
      const err = await refusal(
        pricing.price(
          LINK,
          {
            originChain: 'tron',
            originAsset: 'USDT',
            refundTo: PAYER,
            amount: '30',
          },
          false,
        ),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      // Its own amount, written another way, is the same amount.
      await expect(
        pricing.price(
          LINK,
          {
            originChain: 'tron',
            originAsset: 'USDT',
            refundTo: PAYER,
            amount: '25.000',
          },
          false,
        ),
      ).resolves.toMatchObject({ amountOut: '25' });
    });
  });

  describe('a merchant fee on a network paid through deposits', () => {
    const fee = (paidBy: 'payer' | 'recipient') => ({
      ...LINK,
      amount: '100',
      merchantFee: {
        bps: 150,
        fixed: '0',
        amount: '1.5',
        asset: 'USDC',
        wallet: 'merchant.near',
        paidBy,
      },
    });

    it('rides as the route app fee to the fee account, in basis points of what is paid out', async () => {
      const { pricing, nearIntents } = build();
      const priced = await pricing.price(
        fee('payer'),
        { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
        false,
      );
      const request = nearIntents.quote.mock.calls[0][0];
      // The merchant gets the whole amount; 1.5 / 101.5 is 147 basis points.
      expect(request.amount).toBe('100000000');
      expect(request.appFees).toEqual([
        { recipient: 'cosmospay.near', fee: 50 },
        { recipient: 'merchant.near', fee: 147 },
      ]);
      expect(priced.merchantFee).toMatchObject({
        wallet: 'merchant.near',
        asset: 'USDT',
        // 147 bps of the deposit, in the origin asset.
        amount: '0.371678',
      });
    });

    it('comes out of the amount when the recipient pays it', async () => {
      const { pricing, nearIntents } = build();
      const priced = await pricing.price(
        fee('recipient'),
        { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
        false,
      );
      expect(nearIntents.quote.mock.calls[0][0].amount).toBe('98500000');
      expect(priced.amountOut).toBe('98.5');
      expect(nearIntents.quote.mock.calls[0][0].appFees[1]).toEqual({
        recipient: 'merchant.near',
        fee: 150,
      });
    });

    it('is not an app fee on Stellar, Solana or Monad, whose fees go on the chain', async () => {
      const { pricing, nearIntents } = build();
      nearIntents.tokens.mockResolvedValueOnce([
        ...TOKENS,
        {
          assetId: 'nep141:sol-usdc.omft.near',
          decimals: 6,
          blockchain: 'sol',
          symbol: 'USDC',
          contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          price: 1,
        },
      ]);
      await pricing.price(
        {
          ...fee('payer'),
          chain: 'solana',
          destination: 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN',
          assetIssuer: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        },
        { originChain: 'tron', originAsset: 'USDT', refundTo: PAYER },
        false,
      );
      expect(nearIntents.quote.mock.calls[0][0].appFees).toEqual([
        { recipient: 'cosmospay.near', fee: 50 },
      ]);
    });
  });

  describe('linkAssetForCreate', () => {
    it('resolves a symbol, a contract or the native coin', async () => {
      const { pricing } = build();
      await expect(
        pricing.linkAssetForCreate('base', 'USDC', undefined),
      ).resolves.toMatchObject({ contract: BASE_USDC, decimals: 6 });
      await expect(
        pricing.linkAssetForCreate('base', undefined, BASE_USDC.toUpperCase()),
      ).resolves.toMatchObject({ symbol: 'USDC' });
      await expect(
        pricing.linkAssetForCreate('base', undefined, undefined),
      ).resolves.toMatchObject({ symbol: 'ETH', contract: null });
    });

    it('refuses a symbol that is not the named contract, and an untraded token', async () => {
      const { pricing } = build();
      expect(
        (await refusal(pricing.linkAssetForCreate('base', 'ETH', BASE_USDC)))
          .code,
      ).toBe(ApiErrorCode.ValidationFailed);
      expect(
        (
          await refusal(
            pricing.linkAssetForCreate('base', 'NOPRICE', undefined),
          )
        ).code,
      ).toBe(ApiErrorCode.AssetUnsupported);
      expect(
        (await refusal(pricing.linkAssetForCreate('tron', 'DOGE', undefined)))
          .code,
      ).toBe(ApiErrorCode.AssetUnsupported);
    });
  });
});
