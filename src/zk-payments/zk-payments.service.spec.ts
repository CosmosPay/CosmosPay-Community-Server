import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { AppConfig, ZkNetworkConfig } from '@/config/configuration';
import type { PrismaService } from '@/prisma/prisma.service';
import type { ConfidentialSdk } from '@/zk-payments/confidential-sdk';
import { ZkNetworksService } from '@/zk-payments/zk-networks.service';
import { ZkPaymentsService } from '@/zk-payments/zk-payments.service';

const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const MERCHANT = 'GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP';
const FEE_ACCOUNT = 'GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N';

const ZK: ZkNetworkConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  token: TOKEN,
  auditorRegistry: 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
  verifier: 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3',
  underlying: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  auditorSecret: '0f'.repeat(32),
  feeAccount: FEE_ACCOUNT,
  deployedAtLedger: 5387137,
};

const devKey: GatewayConsumer = {
  username: 'cosmos_merchant',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'admin',
  permissions: [],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};
const prodKey: GatewayConsumer = { ...devKey, environment: 'prod' };

function setup() {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    zkPayment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: 'zkp_1',
          status: 'PENDING',
          payer: null,
          paymentTxHash: null,
          feeTxHash: null,
          settledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        created.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'consumer_1' }),
  };
  const sdk = {
    account: jest.fn().mockResolvedValue({ registered: true, auditorId: 0 }),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'zkPayments'
        ? { testnet: ZK, public: null }
        : { network: 'testnet' },
    ),
  } as unknown as ConfigService<AppConfig, true>;
  const service = new ZkPaymentsService(
    config,
    prisma as unknown as PrismaService,
    consumers as unknown as ConsumerResolverService,
    new ZkNetworksService(config),
    sdk as unknown as ConfidentialSdk,
  );
  return { service, prisma, sdk, created };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('ZkPaymentsService', () => {
  describe('getConfig', () => {
    it("describes the API key's network", () => {
      const { service } = setup();
      expect(service.getConfig(devKey)).toMatchObject({
        enabled: true,
        network: 'testnet',
        token: { contractId: TOKEN, symbol: 'XLM', decimals: 7 },
        auditorId: 0,
        feeBps: 1,
        feeAccount: FEE_ACCOUNT,
      });
      expect(service.getConfig(prodKey)).toMatchObject({
        enabled: false,
        network: 'public',
        token: null,
      });
    });
  });

  describe('create', () => {
    it('prices, checks the recipient on-chain and stores the payment', async () => {
      const { service, prisma, sdk } = setup();
      const before = Date.now();
      const payment = await service.create(devKey, {
        amount: '25.5000000',
        recipient: MERCHANT,
        description: 'Order #24',
      });
      expect(sdk.account).toHaveBeenCalledWith(ZK, MERCHANT);
      const data = prisma.zkPayment.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        consumerId: 'consumer_1',
        network: 'testnet',
        tokenContract: TOKEN,
        amount: '25.5',
        netAmount: '25.49745',
        feeAmount: '0.00255',
        feeBps: 1,
        recipient: MERCHANT,
        feeAccount: FEE_ACCOUNT,
        description: 'Order #24',
      });
      // A minted key when the request names none.
      expect(data.idempotencyKey).toMatch(/^zkp_[0-9a-f]{32}$/);
      // The default lifetime: 60 minutes.
      const expires = (data.expiresAt as Date).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 60 * 60_000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
      expect(payment).not.toHaveProperty('consumerId');
      expect(payment.status).toBe('PENDING');
    });

    it('honours expiresInMinutes', async () => {
      const { service, prisma } = setup();
      const before = Date.now();
      await service.create(devKey, {
        amount: '1',
        recipient: MERCHANT,
        expiresInMinutes: 5,
      });
      const data = prisma.zkPayment.create.mock.calls[0][0].data as {
        expiresAt: Date;
      };
      expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 5 * 60_000,
      );
      expect(data.expiresAt.getTime()).toBeLessThan(before + 6 * 60_000);
    });

    it('refuses a network ZK payments do not run on, before anything else', async () => {
      const { service, sdk, prisma } = setup();
      expect(
        await codeOf(
          service.create(prodKey, { amount: '25', recipient: MERCHANT }),
        ),
      ).toBe(ApiErrorCode.NetworkUnsupported);
      expect(sdk.account).not.toHaveBeenCalled();
      expect(prisma.zkPayment.create).not.toHaveBeenCalled();
    });

    it('refuses an amount that leaves the merchant nothing', async () => {
      const { service } = setup();
      expect(
        await codeOf(
          service.create(devKey, { amount: '0.0000001', recipient: MERCHANT }),
        ),
      ).toBe(ApiErrorCode.InvalidAmount);
    });

    it('refuses the fee account as the recipient', async () => {
      const { service } = setup();
      expect(
        await codeOf(
          service.create(devKey, { amount: '25', recipient: FEE_ACCOUNT }),
        ),
      ).toBe(ApiErrorCode.ValidationFailed);
    });

    it.each([
      ['not registered', { registered: false, auditorId: null }],
      ['registered under another auditor', { registered: true, auditorId: 1 }],
    ])('refuses a recipient %s', async (_label, account) => {
      const { service, sdk, prisma } = setup();
      sdk.account.mockResolvedValue(account);
      expect(
        await codeOf(
          service.create(devKey, { amount: '25', recipient: MERCHANT }),
        ),
      ).toBe(ApiErrorCode.RecipientNotRegistered);
      expect(prisma.zkPayment.create).not.toHaveBeenCalled();
    });

    it('takes the Idempotency-Key header over the body', async () => {
      const { service, prisma } = setup();
      await service.create(
        devKey,
        { amount: '25', recipient: MERCHANT, idempotencyKey: 'from-body' },
        '  from-header  ',
      );
      expect(prisma.zkPayment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            consumerId_idempotencyKey: {
              consumerId: 'consumer_1',
              idempotencyKey: 'from-header',
            },
          },
        }),
      );
    });

    it('replays the stored payment for the same request, without the chain', async () => {
      const { service, prisma, sdk } = setup();
      const stored = {
        id: 'zkp_stored',
        status: 'PENDING',
        network: 'testnet',
        amount: '25',
        recipient: MERCHANT,
        description: null,
        expiresAt: new Date(Date.now() + 60_000),
      };
      prisma.zkPayment.findUnique.mockResolvedValue(stored);
      const replay = await service.create(devKey, {
        amount: '25.0',
        recipient: MERCHANT,
        idempotencyKey: 'order-24',
      });
      expect(replay.id).toBe('zkp_stored');
      expect(sdk.account).not.toHaveBeenCalled();
      expect(prisma.zkPayment.create).not.toHaveBeenCalled();
    });

    it('answers 409 for the same key with another request', async () => {
      const { service, prisma } = setup();
      prisma.zkPayment.findUnique.mockResolvedValue({
        id: 'zkp_stored',
        status: 'PENDING',
        network: 'testnet',
        amount: '30',
        recipient: MERCHANT,
        description: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(
        await codeOf(
          service.create(devKey, {
            amount: '25',
            recipient: MERCHANT,
            idempotencyKey: 'order-24',
          }),
        ),
      ).toBe(ApiErrorCode.IdempotencyConflict);
    });

    it('holds the loser of a create race to the same replay rule', async () => {
      const { service, prisma } = setup();
      prisma.zkPayment.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );
      prisma.zkPayment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'zkp_winner',
          status: 'PENDING',
          network: 'testnet',
          amount: '25',
          recipient: MERCHANT,
          description: null,
          expiresAt: new Date(Date.now() + 60_000),
        });
      const result = await service.create(devKey, {
        amount: '25',
        recipient: MERCHANT,
        idempotencyKey: 'order-24',
      });
      expect(result.id).toBe('zkp_winner');
    });
  });

  describe('reads', () => {
    it('lists the consumer payments with the status as it reads now', async () => {
      const { service, prisma } = setup();
      prisma.zkPayment.findMany.mockResolvedValue([
        {
          id: 'zkp_old',
          status: 'PENDING',
          expiresAt: new Date(Date.now() - 1000),
        },
      ]);
      prisma.zkPayment.count.mockResolvedValue(1);
      const page = await service.findAll(devKey, {
        status: 'EXPIRED',
        take: 20,
        skip: 0,
      });
      expect(page).toMatchObject({ total: 1, take: 20, skip: 0 });
      expect(page.data[0].status).toBe('EXPIRED');
      const where = prisma.zkPayment.findMany.mock.calls[0][0].where as Record<
        string,
        unknown
      >;
      expect(where.consumer).toEqual({ apisixUsername: 'cosmos_merchant' });
      expect(where.OR).toBeDefined();
    });

    it("is a 404 for a payment that is not the consumer's", async () => {
      const { service, prisma } = setup();
      expect(await codeOf(service.findOne(devKey, 'zkp_x'))).toBe(
        ApiErrorCode.NotFound,
      );
      expect(prisma.zkPayment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'zkp_x',
            consumer: { apisixUsername: 'cosmos_merchant' },
          },
        }),
      );
    });
  });
});
