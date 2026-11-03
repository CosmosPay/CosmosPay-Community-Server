import { Logger } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { ProtectedPayment } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { PrismaService } from '@/prisma/prisma.service';
import type { CreateProtectedPaymentDto } from '@/native-plugins/trustless-work/dto/protected-payment.dto';
import type { ProtectedPaymentActionsService } from '@/native-plugins/trustless-work/protected-payment-actions.service';
import type { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import type { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import {
  ProtectedPaymentsService,
  usdcIssuer,
} from '@/native-plugins/trustless-work/protected-payments.service';
import type { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

const MERCHANT = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const platform = Keypair.random();
const RESOLVER = Keypair.random().publicKey();

const consumer = (environment: 'dev' | 'prod' = 'dev'): GatewayConsumer => ({
  username: 'cosmos_merchant',
  credentialId: null,
  environment,
  role: 'user',
  permissions: ['payments:read', 'payments:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
});

const DTO: CreateProtectedPaymentDto = {
  amount: '125.50',
  releaseModel: 'BUYER_RELEASES',
  deadlinePolicy: 'REFUND_BUYER',
  deliveryWindowHours: 168,
  merchantAddress: MERCHANT,
  title: 'Order #1042',
};

function setup({ configured = true } = {}) {
  const rows: ProtectedPayment[] = [];
  const prisma = {
    protectedPayment: {
      create: jest.fn(({ data }: { data: Partial<ProtectedPayment> }) => {
        const row = {
          id: `pp_${rows.length + 1}`,
          status: 'CREATED',
          contractId: null,
          createdAt: new Date(),
          ...data,
        } as ProtectedPayment;
        rows.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: {
            consumerId_idempotencyKey: {
              consumerId: string;
              idempotencyKey: string;
            };
          };
        }) =>
          Promise.resolve(
            rows.find(
              (r) =>
                r.consumerId === where.consumerId_idempotencyKey.consumerId &&
                r.idempotencyKey ===
                  where.consumerId_idempotencyKey.idempotencyKey,
            ) ?? null,
          ),
      ),
      findFirst: jest.fn(({ where }: { where: Partial<ProtectedPayment> }) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.id === where.id &&
              r.consumerId === where.consumerId &&
              r.network === where.network,
          ) ?? null,
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  } as unknown as PrismaService;
  const consumers = {
    resolve: jest.fn(() => Promise.resolve({ id: 'local_merchant' })),
    resolveId: jest.fn(() => Promise.resolve('local_merchant')),
  } as unknown as ConsumerResolverService;
  const keys = {
    isConfigured: jest.fn(() => configured),
    platform: jest.fn(() => platform),
    disputeResolverFor: jest.fn((_network: string, policy: string) => {
      if (policy === 'RELEASE_MERCHANT') {
        throw ApiError.unavailable(ApiErrorCode.Misconfigured, 'no resolver');
      }
      return RESOLVER;
    }),
    serverAccounts: jest.fn(() => [platform.publicKey(), RESOLVER]),
  } as unknown as TrustlessWorkKeys;
  const transactions = {
    outstanding: jest.fn().mockResolvedValue(false),
  } as unknown as ProtectedPaymentTransactionsService;
  const actions = {
    balanceOf: jest.fn().mockResolvedValue(0n),
  } as unknown as ProtectedPaymentActionsService;
  const lifecycle = {
    created: jest.fn().mockResolvedValue(undefined),
    step: jest.fn((id: string, name: string) =>
      Promise.resolve({ ...rows.find((r) => r.id === id)!, status: name }),
    ),
  } as unknown as ProtectedPaymentLifecycle;
  const config = {
    get: jest.fn((key: string) =>
      key === 'trustlessWork'
        ? { platformFeeBps: 165 }
        : key === 'paymentIntents'
          ? { checkoutUrl: 'https://payments.cosmospay.lat' }
          : { network: 'testnet' },
    ),
  };
  const service = new ProtectedPaymentsService(
    prisma,
    consumers,
    keys,
    actions,
    transactions,
    lifecycle,
    config as never,
  );
  return { service, rows, prisma, lifecycle, transactions, actions };
}

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('ProtectedPaymentsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('create', () => {
    it('stores the payment on the key’s network, with the fee and the registry’s USDC, and emits CREATED', async () => {
      const { service, rows, lifecycle } = setup();
      const view = await service.create(consumer(), DTO);
      expect(rows[0]).toMatchObject({
        consumerId: 'local_merchant',
        network: 'testnet',
        amount: '125.5',
        asset: 'USDC',
        assetIssuer: usdcIssuer('testnet'),
        platformAddress: platform.publicKey(),
        disputeResolverAddress: RESOLVER,
        platformFeeBps: 165,
        buyerAddress: null,
      });
      expect(lifecycle.created).toHaveBeenCalledWith(rows[0]);
      expect(view.checkoutUrl).toBe(
        `https://payments.cosmospay.lat/protected/${rows[0].id}`,
      );
      expect(view).not.toHaveProperty('consumerId');
      expect(view).not.toHaveProperty('idempotencyKey');
    });

    it('creates on mainnet for a prod key', async () => {
      const { service, rows } = setup();
      await service.create(consumer('prod'), DTO);
      expect(rows[0]).toMatchObject({
        network: 'public',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      });
    });

    it('is 503 misconfigured on a network without Trustless Work, or without the policy’s resolver', async () => {
      expect(
        (
          await refusal(
            setup({ configured: false }).service.create(consumer(), DTO),
          )
        ).code,
      ).toBe(ApiErrorCode.Misconfigured);
      const error = await refusal(
        setup().service.create(consumer(), {
          ...DTO,
          deadlinePolicy: 'RELEASE_MERCHANT',
        }),
      );
      expect(error.getStatus()).toBe(503);
    });

    it('refuses an amount out of bounds, a buyer who is the merchant, and a platform account', async () => {
      const { service } = setup();
      expect(
        (await refusal(service.create(consumer(), { ...DTO, amount: '0.5' })))
          .code,
      ).toBe(ApiErrorCode.InvalidAmount);
      expect(
        (
          await refusal(
            service.create(consumer(), { ...DTO, amount: '1000000.0000001' }),
          )
        ).code,
      ).toBe(ApiErrorCode.InvalidAmount);
      expect(
        (
          await refusal(
            service.create(consumer(), { ...DTO, buyerAddress: MERCHANT }),
          )
        ).code,
      ).toBe(ApiErrorCode.ValidationFailed);
      expect(
        (
          await refusal(
            service.create(consumer(), { ...DTO, merchantAddress: RESOLVER }),
          )
        ).code,
      ).toBe(ApiErrorCode.ValidationFailed);
    });

    it('replays the same Idempotency-Key and request, and refuses it for another request', async () => {
      const { service, rows } = setup();
      const first = await service.create(consumer(), DTO, 'order-1042');
      const again = await service.create(consumer(), DTO, 'order-1042');
      expect(again.id).toBe(first.id);
      expect(rows).toHaveLength(1);
      const error = await refusal(
        service.create(consumer(), { ...DTO, amount: '99' }, 'order-1042'),
      );
      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe(ApiErrorCode.IdempotencyConflict);
    });

    it('keeps a buyer the merchant names', async () => {
      const { service, rows } = setup();
      await service.create(consumer(), { ...DTO, buyerAddress: BUYER });
      expect(rows[0].buyerAddress).toBe(BUYER);
    });
  });

  describe('tenancy', () => {
    it('reads one payment by id, consumer AND network, and answers 404 for anything else', async () => {
      const { service, prisma } = setup();
      const created = await service.create(consumer(), DTO);
      await expect(
        service.findOne(consumer(), created.id),
      ).resolves.toMatchObject({
        id: created.id,
      });
      expect(prisma.protectedPayment.findFirst).toHaveBeenCalledWith({
        where: {
          id: created.id,
          consumerId: 'local_merchant',
          network: 'testnet',
        },
      });
      // The same merchant's prod key does not see its testnet payment.
      expect(
        (
          await refusal(service.findOne(consumer('prod'), created.id))
        ).getStatus(),
      ).toBe(404);
    });

    it('lists only the key’s network', async () => {
      const { service, prisma } = setup();
      await service.findAll(consumer('prod'), { take: 20, skip: 0 });
      expect(prisma.protectedPayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { consumerId: 'local_merchant', network: 'public' },
        }),
      );
    });
  });

  describe('cancel', () => {
    it('cancels a payment nobody funded', async () => {
      const { service, lifecycle } = setup();
      const created = await service.create(consumer(), DTO);
      const cancelled = await service.cancel(consumer(), created.id);
      expect(lifecycle.step).toHaveBeenCalledWith(created.id, 'CANCELLED');
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('waits while a deposit handed to the buyer can still land', async () => {
      const { service, transactions } = setup();
      const created = await service.create(consumer(), DTO);
      (transactions.outstanding as jest.Mock).mockResolvedValue(true);
      expect((await refusal(service.cancel(consumer(), created.id))).code).toBe(
        ApiErrorCode.OperationInFlight,
      );
    });

    it('refuses a contract that holds funds, and a funded payment', async () => {
      const { service, rows, actions } = setup();
      const created = await service.create(consumer(), DTO);
      Object.assign(rows[0], { status: 'AWAITING_FUNDING', contractId: 'C' });
      (actions.balanceOf as jest.Mock).mockResolvedValue(5n);
      expect((await refusal(service.cancel(consumer(), created.id))).code).toBe(
        ApiErrorCode.InvalidStateTransition,
      );
      rows[0].status = 'FUNDED';
      expect((await refusal(service.cancel(consumer(), created.id))).code).toBe(
        ApiErrorCode.InvalidStateTransition,
      );
    });
  });
});
