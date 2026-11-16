import type { PaymentDeposit } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PaymentDepositsService } from '@/payment-intents/payment-deposits.service';
import { PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK } from '@/payment-intents/payment-intents.constants';

const MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER = 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy';
const ORIGIN = {
  chain: 'tron',
  chainName: 'Tron',
  symbol: 'USDT',
  assetId: 'nep141:tron-usdt.omft.near',
  decimals: 6,
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  priceUsd: 1,
};
const DESTINATION = {
  chain: 'base',
  chainName: 'Base',
  symbol: 'USDC',
  assetId: 'nep141:base-usdc.omft.near',
  decimals: 6,
  contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  priceUsd: 1,
};
const REQUEST = {
  originChain: 'tron' as const,
  originAsset: 'USDT',
  refundTo: PAYER,
};

const INTENT = {
  id: 'pi_1',
  kind: 'PAY',
  chain: 'base',
  network: 'public',
  status: 'PENDING',
  destination: MERCHANT,
  chainReference: null,
  amount: '25',
  asset: 'USDC',
  assetIssuer: DESTINATION.contract,
  merchantFee: null,
  crossChainFeeBps: 50,
  expiresAt: new Date(Date.now() + 3_600_000),
};

function stored(overrides: Partial<PaymentDeposit> = {}): PaymentDeposit {
  return {
    id: 'dep_1',
    intentId: 'pi_1',
    network: 'public',
    status: 'AWAITING_DEPOSIT',
    providerStatus: 'PENDING_DEPOSIT',
    originChain: 'tron',
    originAsset: 'USDT',
    originAssetId: ORIGIN.assetId,
    originContract: ORIGIN.contract,
    originDecimals: 6,
    destinationChain: 'base',
    destinationAsset: 'USDC',
    destinationAssetId: DESTINATION.assetId,
    destinationContract: DESTINATION.contract,
    destinationDecimals: 6,
    amountIn: '25.284231',
    minAmountIn: '25.031458',
    amountOut: '25',
    feeBps: 50,
    feeAmount: '0.126421',
    slippageBps: 100,
    recipient: MERCHANT,
    refundTo: PAYER,
    depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
    depositMemo: null,
    depositUri: null,
    amountOutPaid: null,
    refundedAmount: null,
    originTxHashes: null,
    destinationTxHashes: null,
    timeEstimateSeconds: 82,
    correlationId: 'corr',
    quoteSignature: 'sig',
    quote: {},
    expiresAt: new Date(Date.now() + 30 * 60_000),
    lastCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build(intent: unknown = INTENT, open: PaymentDeposit[] = []) {
  let row: PaymentDeposit | null = null;
  const prisma: any = {
    paymentIntent: { findUnique: jest.fn().mockResolvedValue(intent) },
    paymentDeposit: {
      findMany: jest.fn().mockResolvedValue(open),
      findFirst: jest.fn(),
      create: jest.fn(({ data }) => {
        row = stored({ ...data, id: 'dep_new' });
        return Promise.resolve(row);
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(row)),
    },
  };
  const pricing = {
    originAsset: jest.fn().mockResolvedValue(ORIGIN),
    payableAssets: jest.fn().mockResolvedValue([ORIGIN, DESTINATION]),
    price: jest.fn().mockImplementation((_intent, _request, live) =>
      Promise.resolve({
        origin: ORIGIN,
        destination: DESTINATION,
        amountIn: '25.284231',
        minAmountIn: '25.031458',
        amountOut: '25',
        feeBps: 50,
        feeAmount: '0.126421',
        slippageBps: 100,
        recipient: MERCHANT,
        refundTo: PAYER,
        request: { deadline: '2026-11-16T15:30:00.000Z' },
        response: {
          correlationId: 'corr',
          signature: 'sig',
          quote: {
            amountInUsd: '25.27',
            amountOutUsd: '24.99',
            timeEstimate: 82,
            ...(live
              ? {
                  depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
                  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
                }
              : {}),
          },
        },
      }),
    ),
  };
  const paymentIntents = {
    assertOwned: jest.fn().mockResolvedValue('base'),
    settleFromDeposit: jest.fn().mockResolvedValue({}),
  };
  const accounts = { load: jest.fn(), assertCanReceive: jest.fn() };
  const service = new PaymentDepositsService(
    prisma,
    pricing as never,
    paymentIntents as never,
    accounts as never,
  );
  const setRow = (r: PaymentDeposit) => {
    row = r;
  };
  return { service, prisma, pricing, paymentIntents, accounts, setRow };
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

describe('PaymentDepositsService', () => {
  describe('which links take a payment from another network', () => {
    it('is the 404 of a missing intent for an unknown id', async () => {
      const { service } = build(null);
      expect((await refusal(service.assets('nope'))).code).toBe(
        ApiErrorCode.NotFound,
      );
    });

    it('refuses a link that cannot be paid from another network, naming why', async () => {
      const { service, pricing } = build({ ...INTENT, amount: null });
      const err = await refusal(service.quote('pi_1', REQUEST));
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toMatch(/no fixed amount/);
      expect(pricing.price).not.toHaveBeenCalled();
    });

    it('lists the assets for a payable link, open or not', async () => {
      const { service } = build({ ...INTENT, status: 'SUCCEEDED' });
      await expect(service.assets('pi_1')).resolves.toEqual({
        data: [ORIGIN, DESTINATION],
      });
    });

    it('quotes and opens deposits only while the link is open', async () => {
      for (const intent of [
        { ...INTENT, status: 'SUCCEEDED' },
        { ...INTENT, expiresAt: new Date(Date.now() - 1000) },
      ]) {
        const { service } = build(intent);
        expect((await refusal(service.quote('pi_1', REQUEST))).code).toBe(
          ApiErrorCode.InvalidStateTransition,
        );
        expect((await refusal(service.create('pi_1', REQUEST))).code).toBe(
          ApiErrorCode.InvalidStateTransition,
        );
      }
    });
  });

  it('answers a dry quote as the payer reads it', async () => {
    const { service, pricing } = build();
    const quote = await service.quote('pi_1', REQUEST);
    expect(pricing.price.mock.calls[0][2]).toBe(false);
    expect(quote).toEqual({
      origin: {
        chain: 'tron',
        asset: 'USDT',
        assetId: ORIGIN.assetId,
        contract: ORIGIN.contract,
        amount: '25.284231',
        minimum: '25.031458',
        amountUsd: '25.27',
      },
      destination: {
        chain: 'base',
        asset: 'USDC',
        contract: DESTINATION.contract,
        amount: '25',
        amountUsd: '24.99',
      },
      fee: { bps: 50, amount: '0.126421', asset: 'USDT' },
      timeEstimateSeconds: 82,
    });
  });

  describe('create', () => {
    it('stores a live quote as a deposit of this link and answers its address', async () => {
      const { service, prisma } = build();
      const deposit = await service.create('pi_1', REQUEST);

      expect(prisma.paymentDeposit.create.mock.calls[0][0].data).toMatchObject({
        intentId: 'pi_1',
        network: 'public',
        status: 'AWAITING_DEPOSIT',
        originChain: 'tron',
        destinationChain: 'base',
        amountOut: '25',
        recipient: MERCHANT,
        refundTo: PAYER,
        depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
      });
      expect(deposit).toMatchObject({
        id: 'dep_new',
        paymentLinkId: 'pi_1',
        depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
      });
      expect(deposit.qr).toMatch(/^data:image\/png;base64,/);
      expect(JSON.stringify(deposit)).not.toContain('"quote"');
    });

    it('answers the open deposit again for the same asset and refund address', async () => {
      const open = stored();
      const { service, prisma, pricing } = build(INTENT, [open]);
      const deposit = await service.create('pi_1', REQUEST);
      expect(deposit.id).toBe('dep_1');
      expect(pricing.price).not.toHaveBeenCalled();
      expect(prisma.paymentDeposit.create).not.toHaveBeenCalled();
    });

    it('makes a new one for another refund address', async () => {
      const { service, prisma } = build(INTENT, [
        stored({ refundTo: 'TBia4uHnb3oSSZm5isP284cA7Np1v15Vhi' }),
      ]);
      await service.create('pi_1', REQUEST);
      expect(prisma.paymentDeposit.create).toHaveBeenCalled();
    });

    it('takes no more than the cap of open deposits per link', async () => {
      const open = Array.from(
        { length: PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK },
        (_, i) => stored({ id: `dep_${i}`, refundTo: `T${i}` }),
      );
      const { service, pricing } = build(INTENT, open);
      const err = await refusal(service.create('pi_1', REQUEST));
      expect(err.code).toBe(ApiErrorCode.OperationInFlight);
      expect(pricing.price).not.toHaveBeenCalled();
    });

    it('checks a Stellar merchant trusts the asset before handing out an address', async () => {
      const { service, pricing, accounts } = build();
      pricing.price.mockImplementationOnce(() =>
        Promise.resolve({
          origin: ORIGIN,
          destination: {
            ...DESTINATION,
            chain: 'stellar',
            contract:
              'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          },
          recipient: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
          request: { deadline: new Date().toISOString() },
          response: { quote: { depositAddress: 'TX' } },
        }),
      );
      accounts.load.mockResolvedValue({ balances: [] });
      accounts.assertCanReceive.mockImplementation(() => {
        throw ApiError.badRequest(
          ApiErrorCode.TrustlineMissing,
          'no trustline',
        );
      });
      const err = await refusal(service.create('pi_1', REQUEST));
      expect(err.code).toBe(ApiErrorCode.TrustlineMissing);
    });
  });

  it('reads a deposit only through its own link', async () => {
    const { service, prisma } = build();
    prisma.paymentDeposit.findFirst.mockResolvedValueOnce(null);
    expect((await refusal(service.findPublic('pi_other', 'dep_1'))).code).toBe(
      ApiErrorCode.NotFound,
    );
    expect(prisma.paymentDeposit.findFirst).toHaveBeenCalledWith({
      where: { id: 'dep_1', intentId: 'pi_other' },
    });
  });

  it("lists an owner's deposits only after checking the intent is theirs", async () => {
    const { service, prisma, paymentIntents } = build();
    paymentIntents.assertOwned.mockRejectedValueOnce(
      ApiError.notFound('Payment intent pi_1 not found'),
    );
    await expect(service.listForOwner({} as never, 'pi_1')).rejects.toThrow(
      ApiError,
    );
    expect(prisma.paymentDeposit.findMany).not.toHaveBeenCalled();
  });

  describe('applyProviderStatus', () => {
    it('follows the route and settles the link when the merchant is paid', async () => {
      const { service, prisma, paymentIntents, setRow } = build();
      const paid = stored({
        status: 'SUCCEEDED',
        amountOutPaid: '25',
        destinationTxHashes: [
          { hash: '0xPAYOUT', explorerUrl: 'https://basescan.org/tx/0xpayout' },
        ],
      });
      setRow(paid);

      await service.applyProviderStatus(stored({ status: 'PROCESSING' }), {
        correlationId: 'corr',
        status: 'SUCCESS',
        updatedAt: '',
        swapDetails: {
          amountOut: '25000000',
          amountOutFormatted: '25',
          originChainTxHashes: [],
          destinationChainTxHashes: [
            {
              hash: '0xPAYOUT',
              explorerUrl: 'https://basescan.org/tx/0xpayout',
            },
          ],
        },
      });

      expect(prisma.paymentDeposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'dep_1', status: 'PROCESSING' },
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          amountOutPaid: '25',
          providerStatus: 'SUCCESS',
        }),
      });
      expect(paymentIntents.settleFromDeposit).toHaveBeenCalledWith(
        'pi_1',
        '0xPAYOUT',
        expect.objectContaining({ depositId: 'dep_1', chain: 'tron' }),
      );
    });

    it('does not settle on a payout below the link amount', async () => {
      const { service, paymentIntents, setRow } = build();
      setRow(
        stored({
          status: 'SUCCEEDED',
          amountOutPaid: '24',
          destinationTxHashes: [{ hash: '0x1', explorerUrl: 'https://x' }],
        }),
      );
      await service.applyProviderStatus(stored({ status: 'PROCESSING' }), {
        correlationId: 'corr',
        status: 'SUCCESS',
        updatedAt: '',
      });
      expect(paymentIntents.settleFromDeposit).not.toHaveBeenCalled();
    });

    it('expires a deposit nobody paid once its deadline passes', async () => {
      const lapsed = stored({ expiresAt: new Date(Date.now() - 1000) });
      const { service, prisma, setRow } = build();
      setRow({ ...lapsed, status: 'EXPIRED' });
      await service.applyProviderStatus(lapsed, null);
      expect(
        prisma.paymentDeposit.updateMany.mock.calls[0][0].data,
      ).toMatchObject({ status: 'EXPIRED' });
    });
  });
});
