import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

const EVM_DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const prodConsumer = {
  username: 'cosmos_u1',
  environment: 'prod',
  planSwapFeeBps: 50,
} as never;
const devConsumer = {
  username: 'cosmos_u1',
  environment: 'dev',
  planSwapFeeBps: 50,
} as never;

const USDC_ON_BASE = {
  chain: 'base',
  chainName: 'Base',
  symbol: 'USDC',
  assetId: `nep141:base-${BASE_USDC}.omft.near`,
  decimals: 6,
  contract: BASE_USDC,
  priceUsd: 1,
};

function build(options: { feeRecipient?: string; stored?: unknown[] } = {}) {
  const findUnique = jest.fn();
  for (const row of options.stored ?? [null]) {
    findUnique.mockResolvedValueOnce(row);
  }
  const rows: Record<string, any> = {};
  const create = jest.fn(({ data }) => {
    const row = {
      id: 'pi_new',
      createdAt: new Date(),
      updatedAt: new Date(),
      txHash: null,
      reference: null,
      merchantFee: null,
      paidFrom: null,
      ...data,
    };
    rows[row.id] = row;
    return Promise.resolve(row);
  });
  const prisma: any = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    paymentIntent: {
      findUnique,
      create,
      update: jest.fn(({ where, data }) =>
        Promise.resolve({ ...rows[where.id], ...data }),
      ),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const values: Record<string, unknown> = {
    stellar: { network: 'testnet', swap: { feeWallet: '', feeBps: 0 } },
    paymentIntents: {
      ttlSeconds: 3600,
      checkoutUrl: 'https://payments.cosmospay.lat',
    },
    nearIntents: { feeRecipient: options.feeRecipient ?? 'cosmospay.near' },
    nodeEnv: 'test',
    swapCommissionDevWaiver: false,
  };
  const config = { get: (key: string) => values[key] } as never;
  const pricing = {
    linkAssetForCreate: jest.fn().mockResolvedValue(USDC_ON_BASE),
  };
  const emitter = { emit: jest.fn() };
  const service = new PaymentIntentsService(
    config,
    prisma,
    new WebhookTerminalEmitter(prisma, emitter as never),
    { for: () => ({}) } as never,
    new Sep7LinkBuilder(config, {} as never, {} as never),
    new ConsumerResolverService(prisma),
    { ensureForPayer: jest.fn() } as never,
    {} as never,
    pricing as never,
  );
  return { service, prisma, pricing, emitter };
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

describe('PaymentIntentsService: links on networks paid through deposits', () => {
  it('stores a Base link as the hosted checkout, with its asset and commission', async () => {
    const { service, prisma, pricing } = build();

    const view = await service.createPay(prodConsumer, {
      chain: 'base',
      destination: EVM_DEST.toLowerCase(),
      amount: '25',
      assetCode: 'USDC',
      memo: '42',
    });

    expect(pricing.linkAssetForCreate).toHaveBeenCalledWith(
      'base',
      'USDC',
      undefined,
    );
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      kind: 'PAY',
      chain: 'base',
      network: 'public',
      // One spelling per account: EIP-55, as on Monad.
      destination: EVM_DEST,
      amount: '25',
      asset: 'USDC',
      assetIssuer: BASE_USDC,
      assetDecimals: 6,
      crossChainFeeBps: 50,
      xdr: null,
      callback: null,
    });
    expect(view.uri).toBe('https://payments.cosmospay.lat/pi_new');
    expect(view.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('stores the native coin as `native`, like every other chain', async () => {
    const { service, prisma, pricing } = build();
    pricing.linkAssetForCreate.mockResolvedValueOnce({
      ...USDC_ON_BASE,
      symbol: 'ETH',
      decimals: 18,
      contract: null,
    });

    await service.createPay(prodConsumer, {
      chain: 'base',
      destination: EVM_DEST,
      amount: '0.01',
      memo: '43',
    });

    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      asset: 'native',
      assetIssuer: null,
      assetDecimals: 18,
    });
  });

  it('refuses a dev key: the cross-chain route runs on mainnet only', async () => {
    const { service, prisma } = build();
    const err = await refusal(
      service.createPay(devConsumer, {
        chain: 'tron',
        destination: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy',
        amount: '10',
      }),
    );
    expect(err.code).toBe(ApiErrorCode.NetworkUnsupported);
    expect(err.message).not.toMatch(/near|1click/i);
    expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
  });

  it('takes a link without an amount: the payer types it in the checkout', async () => {
    const { service, prisma } = build();
    const view = await service.createPay(prodConsumer, {
      chain: 'base',
      destination: EVM_DEST,
      assetCode: 'USDC',
      memo: '50',
    });
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      chain: 'base',
      amount: null,
      crossChainFeeBps: 50,
    });
    expect(view.uri).toBe('https://payments.cosmospay.lat/pi_new');
  });

  it('takes a merchant fee paid to an account of the cross-chain route', async () => {
    const { service, prisma } = build();
    await service.createPay(prodConsumer, {
      chain: 'base',
      destination: EVM_DEST,
      amount: '100',
      assetCode: 'USDC',
      memo: '51',
      merchantFee: {
        bps: 150,
        // An EVM address is an account of the route too, stored lowercase.
        wallet: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
        paidBy: 'payer',
      } as never,
    });
    expect(
      prisma.paymentIntent.create.mock.calls[0][0].data.merchantFee,
    ).toEqual({
      bps: 150,
      fixed: '0',
      amount: '1.5',
      asset: 'USDC',
      wallet: '0xab5801a7d398351b8be11c439e05c5b3259aec9b',
      paidBy: 'payer',
    });
  });

  it('refuses a fee to an address the route cannot credit, a fee with no amount, and a callback', async () => {
    const { service } = build();
    const base = { chain: 'base' as const, destination: EVM_DEST };
    const refused = async (dto: Record<string, unknown>) =>
      (await refusal(service.createPay(prodConsumer, { ...base, ...dto })))
        .code;

    expect(
      await refused({
        amount: '1',
        merchantFee: { bps: 100, wallet: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy' },
      }),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      await refused({ merchantFee: { bps: 100, wallet: 'merchant.near' } }),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      await refused({ amount: '1', callback: 'url:https://x.example' }),
    ).toBe(ApiErrorCode.ValidationFailed);
  });

  it("stores the merchant's own limits on payments from other networks", async () => {
    const { service, prisma } = build();
    await service.createPay(prodConsumer, {
      chain: 'base',
      destination: EVM_DEST,
      amount: '25',
      memo: '52',
      depositLimits: { perPayer: 4, perWindow: 60 },
    });
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      depositMaxPerPayer: 4,
      depositBudgetPerWindow: 60,
    });
  });

  it('refuses more decimals than the asset has', async () => {
    const { service } = build();
    const err = await refusal(
      service.createPay(prodConsumer, {
        chain: 'base',
        destination: EVM_DEST,
        amount: '1.0000001',
        assetCode: 'USDC',
      }),
    );
    expect(err.code).toBe(ApiErrorCode.InvalidAmount);
  });

  it('refuses a plan commission with nowhere to be collected', async () => {
    const { service } = build({ feeRecipient: '' });
    const err = await refusal(
      service.createPay(prodConsumer, {
        chain: 'base',
        destination: EVM_DEST,
        amount: '25',
      }),
    );
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
  });

  it('answers a replay of the same request with the stored intent', async () => {
    const stored = {
      id: 'pi_old',
      consumerId: 'c1',
      kind: 'PAY',
      chain: 'base',
      network: 'public',
      source: null,
      destination: EVM_DEST,
      amount: '25',
      asset: 'USDC',
      assetIssuer: BASE_USDC,
      assetDecimals: 6,
      msg: null,
      callback: null,
      merchantFee: null,
      paidFrom: null,
      memo: '42',
      uri: 'https://payments.cosmospay.lat/pi_old',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service, prisma } = build({ stored: [stored] });

    const view = await service.createPay(prodConsumer, {
      chain: 'base',
      destination: EVM_DEST,
      amount: '25',
      assetCode: 'USDC',
      memo: '42',
    });

    expect(view.id).toBe('pi_old');
    expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
  });

  it('records a commission on a mainnet Stellar link with an amount', async () => {
    const { service, prisma } = build();
    await service.createPay(prodConsumer, {
      destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
      amount: '10',
      memo: '44',
    });
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      chain: 'stellar',
      crossChainFeeBps: 50,
    });
  });

  it('records one on an open-amount Stellar link too: the payer types the amount', async () => {
    const { service, prisma } = build();
    await service.createPay(prodConsumer, {
      destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
      memo: '45',
    });
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      chain: 'stellar',
      amount: null,
      crossChainFeeBps: 50,
    });
  });

  it('creates a Stellar link without payments from other networks when the commission cannot be collected', async () => {
    const { service, prisma } = build({ feeRecipient: '' });
    await service.createPay(prodConsumer, {
      destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
      amount: '10',
      memo: '46',
    });
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      crossChainFeeBps: null,
    });
  });
});

describe('PaymentIntentsService.settleFromDeposit', () => {
  const paidFrom = {
    depositId: 'dep_1',
    chain: 'tron' as const,
    asset: 'USDT',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    amount: '25.28',
  };
  const intentRow = (status: string, chain = 'base') => ({
    id: 'pi_1',
    status,
    chain,
    consumer: { apisixUsername: 'cosmos_u1' },
  });

  it('settles an open or expired intent on the payout, as verified, with what the payer sent', async () => {
    for (const status of ['PENDING', 'SUBMITTED', 'EXPIRED']) {
      const { service, prisma } = build();
      prisma.paymentIntent.findUnique = jest
        .fn()
        .mockResolvedValue(intentRow(status));
      const transition = jest
        .spyOn(service, 'transition')
        .mockResolvedValue({} as never);

      await service.settleFromDeposit('pi_1', `0x${'AB'.repeat(32)}`, paidFrom);

      expect(transition).toHaveBeenCalledWith('pi_1', 'SUCCEEDED', {
        consumerUsername: 'cosmos_u1',
        actor: 'observer',
        reason: 'paid from tron through a deposit address',
        // Stored in the network's spelling: EVM hashes lowercase.
        txHash: `0x${'ab'.repeat(32)}`,
        verifiedOnChain: true,
        paidFrom,
        // Observed now: the deposit's own session gets the receipt anyway.
        paidAt: expect.any(Date),
      });
    }
  });

  it('leaves a settled, cancelled or failed intent as it is', async () => {
    for (const status of ['SUCCEEDED', 'CANCELLED', 'FAILED']) {
      const { service, prisma } = build();
      prisma.paymentIntent.findUnique = jest
        .fn()
        .mockResolvedValue(intentRow(status));
      const transition = jest.spyOn(service, 'transition');
      await expect(
        service.settleFromDeposit('pi_1', '0xab', paidFrom),
      ).resolves.toBeNull();
      expect(transition).not.toHaveBeenCalled();
    }
  });

  it('refuses a reported transaction on a link paid through deposits', async () => {
    const { service, prisma } = build();
    prisma.paymentIntent.findFirst.mockResolvedValue({
      id: 'pi_1',
      chain: 'base',
      status: 'PENDING',
    });
    const err = await refusal(
      service.validate(prodConsumer, 'pi_1', `0x${'ab'.repeat(32)}`),
    );
    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(err.message).toMatch(/deposit addresses/);
  });
});
