import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig, ZkNetworkConfig } from '@/config/configuration';
import type { PrismaService } from '@/prisma/prisma.service';
import type { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import type {
  ConfidentialSdk,
  ZkTransactionRead,
} from '@/zk-payments/confidential-sdk';
import { ZkCheckoutService } from '@/zk-payments/zk-checkout.service';
import { ZkNetworksService } from '@/zk-payments/zk-networks.service';

const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const MERCHANT = 'GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP';
const FEE_ACCOUNT = 'GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N';
const PAYER = 'GADAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDANWXK';
const FEE_WALLET = 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI';
const PAYMENT_TX = 'a'.repeat(64);
const FEE_TX = 'b'.repeat(64);
const MERCHANT_FEE_TX = 'c'.repeat(64);

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

const CREATED = new Date(Date.now() - 10 * 60_000);
const EXPIRES = new Date(Date.now() + 50 * 60_000);
const PAID_AT = new Date(Date.now() - 5 * 60_000);

/** The full stored row: what the selects must cut down. */
function storedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'zkp_1',
    consumerId: 'consumer_secret_id',
    idempotencyKey: 'order-24',
    status: 'PENDING',
    network: 'testnet',
    tokenContract: TOKEN,
    amount: '25',
    netAmount: '24.9975',
    feeAmount: '0.0025',
    feeBps: 1,
    recipient: MERCHANT,
    feeAccount: FEE_ACCOUNT,
    payer: null,
    paymentTxHash: null,
    feeTxHash: null,
    merchantFee: null,
    merchantFeeTxHash: null,
    description: 'Order #24',
    expiresAt: EXPIRES,
    settledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

function pick(row: Record<string, unknown>, select?: Record<string, unknown>) {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    out[key] =
      key === 'consumer' ? { apisixUsername: 'cosmos_merchant' } : row[key];
  }
  return out;
}

function success(
  txHash: string,
  to: string,
  amount: bigint,
  from = PAYER,
): ZkTransactionRead {
  return {
    status: 'success',
    txHash,
    ledger: 100,
    closedAt: PAID_AT,
    operationCount: 1,
    invocation: { contract: TOKEN, function: 'confidential_transfer' },
    transfers: [
      { from, to, amount, channelsAgree: true, commitmentMatches: true },
    ],
  };
}

function setup(row: Record<string, unknown> | null = storedRow()) {
  let current = row;
  const prisma = {
    zkPayment: {
      findUnique: jest.fn(({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve(current ? pick(current, select) : null),
      ),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (!current || current.status !== 'PENDING') {
          return Promise.resolve({ count: 0 });
        }
        current = { ...current, ...data };
        return Promise.resolve({ count: 1 });
      }),
      findUniqueOrThrow: jest.fn(
        ({ select }: { select?: Record<string, unknown> }) =>
          Promise.resolve(pick(current!, select)),
      ),
    },
  };
  const sdk = {
    readTransaction: jest.fn(
      (_target: unknown, _secret: string, hash: string) =>
        Promise.resolve(
          hash === PAYMENT_TX
            ? success(PAYMENT_TX, MERCHANT, 249_975_000n)
            : success(FEE_TX, FEE_ACCOUNT, 25_000n),
        ),
    ),
  };
  const webhooks = { emit: jest.fn().mockResolvedValue(true) };
  const config = {
    get: jest.fn(() => ({ testnet: ZK, public: null })),
  } as unknown as ConfigService<AppConfig, true>;
  const service = new ZkCheckoutService(
    prisma as unknown as PrismaService,
    new ZkNetworksService(config),
    sdk as unknown as ConfidentialSdk,
    webhooks as unknown as WebhookTerminalEmitter,
  );
  return {
    service,
    prisma,
    sdk,
    webhooks,
    setRow: (r: Record<string, unknown>) => (current = r),
  };
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

describe('ZkCheckoutService', () => {
  describe('config', () => {
    it('describes an enabled network with public values only', () => {
      const { service } = setup();
      const config = service.config('testnet');
      expect(config).toEqual({
        enabled: true,
        network: 'testnet',
        rpcUrl: ZK.rpcUrl,
        networkPassphrase: ZK.networkPassphrase,
        token: {
          contractId: TOKEN,
          symbol: 'XLM',
          decimals: 7,
          underlying: ZK.underlying,
          deployedAtLedger: ZK.deployedAtLedger,
        },
        verifier: ZK.verifier,
        auditorRegistry: ZK.auditorRegistry,
        auditorId: 0,
        feeBps: 1,
        feeAccount: FEE_ACCOUNT,
      });
      expect(JSON.stringify(config)).not.toContain(ZK.auditorSecret);
    });

    it('answers enabled: false, nulls and the known constants for a network without it', () => {
      const { service } = setup();
      expect(service.config('public')).toEqual({
        enabled: false,
        network: 'public',
        rpcUrl: null,
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        token: null,
        verifier: null,
        auditorRegistry: null,
        auditorId: 0,
        feeBps: 1,
        feeAccount: null,
      });
    });
  });

  describe('findPublic', () => {
    it('answers the payer view and nothing of the owner', async () => {
      const { service } = setup();
      const view = await service.findPublic('zkp_1');
      expect(Object.keys(view).sort()).toEqual(
        [
          'id',
          'status',
          'amount',
          'netAmount',
          'feeAmount',
          'feeBps',
          'recipient',
          'feeAccount',
          'merchantFee',
          'description',
          'expiresAt',
          'network',
          'rpcUrl',
          'networkPassphrase',
          'token',
          'auditorId',
        ].sort(),
      );
      expect(view).toMatchObject({
        status: 'PENDING',
        netAmount: '24.9975',
        feeAccount: FEE_ACCOUNT,
        auditorId: 0,
      });
    });

    it('reads a PENDING payment past expiresAt as EXPIRED', async () => {
      const { service } = setup(
        storedRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      expect((await service.findPublic('zkp_1')).status).toBe('EXPIRED');
    });

    it('is a 404 for an unknown id', async () => {
      const { service } = setup(null);
      expect(await codeOf(service.findPublic('nope'))).toBe(
        ApiErrorCode.NotFound,
      );
    });

    it('refuses a payment on a network or token no longer served', async () => {
      expect(
        await codeOf(
          setup(storedRow({ network: 'public' })).service.findPublic('zkp_1'),
        ),
      ).toBe(ApiErrorCode.NetworkUnsupported);
      expect(
        await codeOf(
          setup(
            storedRow({
              tokenContract:
                'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
            }),
          ).service.findPublic('zkp_1'),
        ),
      ).toBe(ApiErrorCode.NetworkUnsupported);
    });
  });

  describe('confirm', () => {
    it('settles on two verified transfers, records them and notifies the owner once', async () => {
      const { service, prisma, sdk, webhooks } = setup();
      const result = await service.confirm('zkp_1', {
        paymentTxHash: PAYMENT_TX.toUpperCase(),
        feeTxHash: FEE_TX,
      });
      expect(result.status).toBe('SUCCEEDED');
      // Both legs read with the auditor secret, the hashes lowercased.
      expect(sdk.readTransaction).toHaveBeenCalledWith(
        ZK,
        ZK.auditorSecret,
        PAYMENT_TX,
      );
      expect(sdk.readTransaction).toHaveBeenCalledWith(
        ZK,
        ZK.auditorSecret,
        FEE_TX,
      );
      // A compare-and-swap on PENDING.
      expect(prisma.zkPayment.updateMany).toHaveBeenCalledWith({
        where: { id: 'zkp_1', status: 'PENDING' },
        data: {
          status: 'SUCCEEDED',
          payer: PAYER,
          paymentTxHash: PAYMENT_TX,
          feeTxHash: FEE_TX,
          merchantFeeTxHash: null,
          settledAt: PAID_AT,
        },
      });
      expect(webhooks.emit).toHaveBeenCalledTimes(1);
      const [username, type, data] = webhooks.emit.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(username).toBe('cosmos_merchant');
      expect(type).toBe('ZK_PAYMENT_SUCCEEDED');
      expect(data).toMatchObject({
        id: 'zkp_1',
        status: 'SUCCEEDED',
        payer: PAYER,
      });
      expect(data).not.toHaveProperty('consumerId');
      expect(data).not.toHaveProperty('consumer');
    });

    it('refuses the same transaction for both legs before reading anything', async () => {
      const { service, prisma } = setup();
      expect(
        await codeOf(
          service.confirm('zkp_1', {
            paymentTxHash: PAYMENT_TX,
            feeTxHash: PAYMENT_TX.toUpperCase(),
          }),
        ),
      ).toBe(ApiErrorCode.ValidationFailed);
      expect(prisma.zkPayment.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a hash that settled another payment, before asking the chain', async () => {
      const { service, prisma, sdk } = setup();
      prisma.zkPayment.findFirst.mockResolvedValue({ id: 'zkp_other' });
      expect(
        await codeOf(
          service.confirm('zkp_1', {
            paymentTxHash: PAYMENT_TX,
            feeTxHash: FEE_TX,
          }),
        ),
      ).toBe(ApiErrorCode.TransactionAlreadySettled);
      expect(prisma.zkPayment.findFirst).toHaveBeenCalledWith({
        where: {
          id: { not: 'zkp_1' },
          OR: [
            { paymentTxHash: { in: [PAYMENT_TX, FEE_TX] } },
            { feeTxHash: { in: [PAYMENT_TX, FEE_TX] } },
            { merchantFeeTxHash: { in: [PAYMENT_TX, FEE_TX] } },
          ],
        },
        select: { id: true },
      });
      expect(sdk.readTransaction).not.toHaveBeenCalled();
    });

    it('leaves the payment PENDING when the chain does not back it', async () => {
      const { service, prisma, sdk, webhooks } = setup();
      sdk.readTransaction.mockImplementation(
        (_t: unknown, _s: string, hash: string) =>
          Promise.resolve(
            hash === PAYMENT_TX
              ? success(PAYMENT_TX, MERCHANT, 1n)
              : success(FEE_TX, FEE_ACCOUNT, 25_000n),
          ),
      );
      expect(
        await codeOf(
          service.confirm('zkp_1', {
            paymentTxHash: PAYMENT_TX,
            feeTxHash: FEE_TX,
          }),
        ),
      ).toBe(ApiErrorCode.PaymentTransferMismatch);
      expect(prisma.zkPayment.updateMany).not.toHaveBeenCalled();
      expect(webhooks.emit).not.toHaveBeenCalled();
    });

    it('refuses transfers that closed after the payment expired', async () => {
      const { service, sdk } = setup(
        storedRow({ expiresAt: new Date(PAID_AT.getTime() - 1000) }),
      );
      expect(
        await codeOf(
          service.confirm('zkp_1', {
            paymentTxHash: PAYMENT_TX,
            feeTxHash: FEE_TX,
          }),
        ),
      ).toBe(ApiErrorCode.Expired);
      expect(sdk.readTransaction).toHaveBeenCalledTimes(2);
    });

    it('still settles a payment that reads EXPIRED when the transfers closed in time', async () => {
      const { service } = setup(
        storedRow({ expiresAt: new Date(PAID_AT.getTime() + 1000) }),
      );
      const result = await service.confirm('zkp_1', {
        paymentTxHash: PAYMENT_TX,
        feeTxHash: FEE_TX,
      });
      expect(result.status).toBe('SUCCEEDED');
    });

    it('answers a settled payment again for its own hashes, without the chain, re-emitting for the dedup to absorb', async () => {
      const { service, sdk, webhooks } = setup(
        storedRow({
          status: 'SUCCEEDED',
          paymentTxHash: PAYMENT_TX,
          feeTxHash: FEE_TX,
        }),
      );
      const result = await service.confirm('zkp_1', {
        paymentTxHash: PAYMENT_TX,
        feeTxHash: FEE_TX,
      });
      expect(result.status).toBe('SUCCEEDED');
      expect(sdk.readTransaction).not.toHaveBeenCalled();
      // The emitter deduplicates on the event key; re-emitting is what heals a
      // settle that died before notifying.
      expect(webhooks.emit).toHaveBeenCalledTimes(1);
      expect(webhooks.emit.mock.calls[0][1]).toBe('ZK_PAYMENT_SUCCEEDED');
    });

    it('refuses other hashes on a settled payment', async () => {
      const { service } = setup(
        storedRow({
          status: 'SUCCEEDED',
          paymentTxHash: 'c'.repeat(64),
          feeTxHash: FEE_TX,
        }),
      );
      expect(
        await codeOf(
          service.confirm('zkp_1', {
            paymentTxHash: PAYMENT_TX,
            feeTxHash: FEE_TX,
          }),
        ),
      ).toBe(ApiErrorCode.InvalidStateTransition);
    });

    it('answers the winner of a race for the same hashes, and notifies once', async () => {
      const { service, prisma, webhooks, setRow } = setup();
      prisma.zkPayment.updateMany.mockImplementation(() => {
        setRow(
          storedRow({
            status: 'SUCCEEDED',
            paymentTxHash: PAYMENT_TX,
            feeTxHash: FEE_TX,
          }),
        );
        return Promise.resolve({ count: 0 });
      });
      const result = await service.confirm('zkp_1', {
        paymentTxHash: PAYMENT_TX,
        feeTxHash: FEE_TX,
      });
      expect(result.status).toBe('SUCCEEDED');
      // The loser re-emits; the emitter's dedup claim keeps it to one delivery.
      expect(webhooks.emit).toHaveBeenCalledTimes(1);
    });

    describe('with a merchant fee', () => {
      // 25 XLM, the recipient pays 1.75 XLM to FEE_WALLET: net 23.2475.
      const feeRow = (over: Record<string, unknown> = {}) =>
        storedRow({
          netAmount: '23.2475',
          merchantFee: {
            bps: 600,
            fixed: '0.25',
            amount: '1.75',
            asset: 'XLM',
            wallet: FEE_WALLET,
            paidBy: 'recipient',
          },
          ...over,
        });
      const threeLegs =
        (merchantFee = success(MERCHANT_FEE_TX, FEE_WALLET, 17_500_000n)) =>
        (_t: unknown, _s: string, hash: string) =>
          Promise.resolve(
            hash === PAYMENT_TX
              ? success(PAYMENT_TX, MERCHANT, 232_475_000n)
              : hash === FEE_TX
                ? success(FEE_TX, FEE_ACCOUNT, 25_000n)
                : merchantFee,
          );
      const hashes = {
        paymentTxHash: PAYMENT_TX,
        feeTxHash: FEE_TX,
        merchantFeeTxHash: MERCHANT_FEE_TX,
      };

      it('settles on three verified transfers and records the third', async () => {
        const { service, prisma, sdk } = setup(feeRow());
        sdk.readTransaction.mockImplementation(threeLegs());
        const result = await service.confirm('zkp_1', hashes);
        expect(result.status).toBe('SUCCEEDED');
        expect(result.merchantFee).toMatchObject({
          amount: '1.75',
          wallet: FEE_WALLET,
        });
        expect(sdk.readTransaction).toHaveBeenCalledTimes(3);
        expect(prisma.zkPayment.updateMany).toHaveBeenCalledWith({
          where: { id: 'zkp_1', status: 'PENDING' },
          data: {
            status: 'SUCCEEDED',
            payer: PAYER,
            ...hashes,
            settledAt: PAID_AT,
          },
        });
      });

      it('refuses a confirm without the merchant fee transaction, before asking the chain', async () => {
        const { service, sdk } = setup(feeRow());
        expect(
          await codeOf(
            service.confirm('zkp_1', {
              paymentTxHash: PAYMENT_TX,
              feeTxHash: FEE_TX,
            }),
          ),
        ).toBe(ApiErrorCode.ValidationFailed);
        expect(sdk.readTransaction).not.toHaveBeenCalled();
      });

      it('refuses a merchant fee transaction on a payment without a merchant fee', async () => {
        const { service, sdk } = setup();
        expect(await codeOf(service.confirm('zkp_1', hashes))).toBe(
          ApiErrorCode.ValidationFailed,
        );
        expect(sdk.readTransaction).not.toHaveBeenCalled();
      });

      it('refuses one transaction named for two legs, before reading anything', async () => {
        const { service, prisma } = setup(feeRow());
        expect(
          await codeOf(
            service.confirm('zkp_1', {
              ...hashes,
              merchantFeeTxHash: FEE_TX.toUpperCase(),
            }),
          ),
        ).toBe(ApiErrorCode.ValidationFailed);
        expect(prisma.zkPayment.findUnique).not.toHaveBeenCalled();
      });

      it('looks for the merchant fee hash in every role among settled payments', async () => {
        const { service, prisma, sdk } = setup(feeRow());
        prisma.zkPayment.findFirst.mockResolvedValue({ id: 'zkp_other' });
        expect(await codeOf(service.confirm('zkp_1', hashes))).toBe(
          ApiErrorCode.TransactionAlreadySettled,
        );
        const all = [PAYMENT_TX, FEE_TX, MERCHANT_FEE_TX];
        expect(prisma.zkPayment.findFirst).toHaveBeenCalledWith({
          where: {
            id: { not: 'zkp_1' },
            OR: [
              { paymentTxHash: { in: all } },
              { feeTxHash: { in: all } },
              { merchantFeeTxHash: { in: all } },
            ],
          },
          select: { id: true },
        });
        expect(sdk.readTransaction).not.toHaveBeenCalled();
      });

      it('leaves the payment PENDING when the merchant fee transfer pays another amount', async () => {
        const { service, prisma, sdk } = setup(feeRow());
        sdk.readTransaction.mockImplementation(
          threeLegs(success(MERCHANT_FEE_TX, FEE_WALLET, 1n)),
        );
        expect(await codeOf(service.confirm('zkp_1', hashes))).toBe(
          ApiErrorCode.MerchantFeeTransferMismatch,
        );
        expect(prisma.zkPayment.updateMany).not.toHaveBeenCalled();
      });

      it('answers a settled payment again only for all three of its hashes', async () => {
        const settled = feeRow({
          status: 'SUCCEEDED',
          ...hashes,
        });
        const { service, sdk } = setup(settled);
        expect((await service.confirm('zkp_1', hashes)).status).toBe(
          'SUCCEEDED',
        );
        expect(sdk.readTransaction).not.toHaveBeenCalled();
        expect(
          await codeOf(
            setup(settled).service.confirm('zkp_1', {
              ...hashes,
              merchantFeeTxHash: 'd'.repeat(64),
            }),
          ),
        ).toBe(ApiErrorCode.InvalidStateTransition);
      });
    });

    it('answers 409 when the unique index catches a concurrent reuse', async () => {
      const { service, prisma } = setup();
      prisma.zkPayment.updateMany.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );
      expect(
        await codeOf(
          service.confirm('zkp_1', {
            paymentTxHash: PAYMENT_TX,
            feeTxHash: FEE_TX,
          }),
        ),
      ).toBe(ApiErrorCode.TransactionAlreadySettled);
    });
  });
});
