import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Asset, Keypair, Networks } from '@stellar/stellar-sdk';
import type { ProtectedPayment } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { PrismaService } from '@/prisma/prisma.service';
import type { StellarAccountLoader } from '@/stellar/account-loader.service';
import { StellarService } from '@/stellar/stellar.service';
import { disputeChallenge } from '@/native-plugins/trustless-work/protected-payment-dispute-challenge';
import { ProtectedPaymentActionsService } from '@/native-plugins/trustless-work/protected-payment-actions.service';
import type { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import type { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import type { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import type { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const buyerKey = Keypair.random();
const BUYER = buyerKey.publicKey();
const MERCHANT = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const platform = Keypair.random();
const resolver = Keypair.random();
const OPS = Keypair.random().publicKey();
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CONTRACT = 'CDERIVEDCONTRACT';

function payment(overrides: Partial<ProtectedPayment> = {}): ProtectedPayment {
  return {
    id: ID,
    consumerId: 'local_merchant',
    network: 'testnet',
    status: 'CREATED',
    releaseModel: 'BUYER_RELEASES',
    deadlinePolicy: 'REFUND_BUYER',
    title: 'Order #1042',
    description: null,
    reference: null,
    amount: '125.5',
    asset: 'USDC',
    assetIssuer: ISSUER,
    merchantAddress: MERCHANT,
    buyerAddress: null,
    platformAddress: platform.publicKey(),
    disputeResolverAddress: resolver.publicKey(),
    platformFeeBps: 165,
    contractId: null,
    fundingExpiresAt: new Date(Date.now() + 3_600_000),
    deliveryWindowHours: 168,
    deployClaimedAt: null,
    ...overrides,
  } as ProtectedPayment;
}

function setup(stored: ProtectedPayment) {
  let current = { ...stored };
  const prisma = {
    protectedPayment: {
      updateMany: jest.fn(({ data }: { data: Partial<ProtectedPayment> }) => {
        current = { ...current, ...data };
        return Promise.resolve({ count: 1 });
      }),
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...current })),
    },
  } as unknown as PrismaService;
  const client = {
    timeoutMs: 1_000,
    deploy: jest.fn().mockResolvedValue('DEPLOY_XDR'),
    fund: jest.fn().mockResolvedValue('FUND_XDR'),
    approveMilestone: jest.fn().mockResolvedValue('APPROVE_XDR'),
    disputeEscrow: jest.fn().mockResolvedValue('DISPUTE_XDR'),
    resolveDispute: jest.fn().mockResolvedValue('RESOLVE_XDR'),
    contracts: jest
      .fn()
      .mockResolvedValue([{ contractId: CONTRACT, balance: 125.5 }]),
  } as unknown as TrustlessWorkClient;
  const keys = {
    platform: jest.fn(() => platform),
    disputeResolverFor: jest.fn(() => resolver.publicKey()),
    serverAccounts: jest.fn(() => [
      platform.publicKey(),
      resolver.publicKey(),
      OPS,
    ]),
    serverKeyFor: jest.fn((_network: string, address: string) =>
      address === resolver.publicKey() ? resolver : null,
    ),
    pins: jest.fn(() => ({ deployer: '', wasmHash: '' })),
  } as unknown as TrustlessWorkKeys;
  let n = 0;
  const transactions = {
    latest: jest.fn().mockResolvedValue(null),
    record: jest.fn(
      (
        _payment: unknown,
        expected: { action: string; signer: string },
        xdr: string,
        context?: object,
      ) =>
        Promise.resolve({
          row: {
            id: `row_${++n}`,
            action: expected.action,
            signer: expected.signer,
            xdr,
            txHash: `hash_${n}`,
            expiresAt: new Date(Date.now() + 300_000),
            status: 'BUILT',
            context:
              expected.action === 'DEPLOY' ? { contractId: CONTRACT } : context,
          },
          ...(expected.action === 'DEPLOY'
            ? {
                deploy: {
                  deployer: 'CDEP',
                  wasmHash: 'ab',
                  contractId: CONTRACT,
                },
              }
            : {}),
        }),
    ),
    relayServerSigned: jest.fn(
      (row: { context: unknown; action: string; txHash: string }) =>
        Promise.resolve({
          row: { ...row, status: 'SUBMITTED' },
          result: { status: 'SUCCESS', message: 'sent' },
          succeeded: true,
        }),
    ),
  } as unknown as ProtectedPaymentTransactionsService;
  const lifecycle = {
    deployed: jest.fn((_id: string, contractId: string) => {
      current = { ...current, contractId, status: 'AWAITING_FUNDING' };
      return Promise.resolve({ ...current });
    }),
    step: jest.fn((_id: string, name: string) =>
      Promise.resolve({ ...current, status: name }),
    ),
  } as unknown as ProtectedPaymentLifecycle;
  const accounts = {
    load: jest.fn((_network: string, address: string) =>
      Promise.resolve({
        balances:
          address === MERCHANT || address === BUYER
            ? [{ asset_code: 'USDC', asset_issuer: ISSUER, balance: '500' }]
            : [],
      }),
    ),
    assertTrustline: jest.fn(),
    assertCanReceive: jest.fn(),
  } as unknown as StellarAccountLoader;
  const config = {
    get: jest.fn(() => ({ network: 'testnet' })),
  } as unknown as ConfigService;
  const service = new ProtectedPaymentActionsService(
    prisma,
    client,
    keys,
    transactions,
    lifecycle,
    accounts,
    new StellarService(config as never),
    config as never,
  );
  return { service, client, transactions, lifecycle, prisma };
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

describe('ProtectedPaymentActionsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('fund', () => {
    it('deploys first, signed by the platform, with the roles of the release model', async () => {
      const { service, client, transactions, lifecycle } = setup(payment());

      const built = await service.fund(payment(), BUYER);

      expect(client.deploy).toHaveBeenCalledWith('testnet', {
        signer: platform.publicKey(),
        engagementId: ID,
        title: 'Order #1042',
        description: 'Order #1042',
        roles: {
          approver: BUYER,
          serviceProvider: MERCHANT,
          platformAddress: platform.publicKey(),
          releaseSigner: BUYER,
          disputeResolver: resolver.publicKey(),
          receiver: MERCHANT,
        },
        amount: 125.5,
        platformFee: 1.65,
        milestones: [{ description: 'Order delivered' }],
        trustline: {
          address: new Asset('USDC', ISSUER).contractId(Networks.TESTNET),
          symbol: 'USDC',
        },
      });
      expect(transactions.relayServerSigned).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DEPLOY' }),
        platform,
      );
      expect(lifecycle.deployed).toHaveBeenCalledWith(ID, CONTRACT);
      expect(client.fund).toHaveBeenCalledWith('testnet', {
        contractId: CONTRACT,
        signer: BUYER,
        amount: 125.5,
      });
      expect(built).toMatchObject({ action: 'FUND', xdr: 'FUND_XDR' });
      expect(built.payment.buyerAddress).toBe(BUYER);
    });

    it('refuses another buyer than the one bound, before any call (409)', async () => {
      const { service, client } = setup(payment({ buyerAddress: BUYER }));
      const error = await refusal(
        service.fund(payment({ buyerAddress: BUYER }), STRANGER),
      );
      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe(ApiErrorCode.ProtectedPaymentBuyerMismatch);
      expect(client.deploy).not.toHaveBeenCalled();
    });

    it('refuses the merchant, or a platform account, as the buyer', async () => {
      const { service, client } = setup(payment());
      expect((await refusal(service.fund(payment(), MERCHANT))).code).toBe(
        ApiErrorCode.ValidationFailed,
      );
      expect((await refusal(service.fund(payment(), OPS))).code).toBe(
        ApiErrorCode.ValidationFailed,
      );
      expect(client.deploy).not.toHaveBeenCalled();
    });

    it('refuses a payment whose funding window closed', async () => {
      const closed = payment({ fundingExpiresAt: new Date(Date.now() - 1) });
      const { service } = setup(closed);
      expect((await refusal(service.fund(closed, BUYER))).code).toBe(
        ApiErrorCode.InvalidStateTransition,
      );
    });

    it('answers 409 while another request holds the deploy', async () => {
      const { service, prisma, client } = setup(payment());
      (prisma.protectedPayment.updateMany as jest.Mock).mockResolvedValueOnce({
        count: 0,
      });
      const error = await refusal(service.fund(payment(), BUYER));
      expect(error.code).toBe(ApiErrorCode.OperationInFlight);
      expect(client.deploy).not.toHaveBeenCalled();
    });

    it('keeps the contract the signed deploy creates when Trustless Work reports another', async () => {
      const { service, transactions, lifecycle } = setup(payment());
      (transactions.relayServerSigned as jest.Mock).mockImplementationOnce(
        (row: object) =>
          Promise.resolve({
            row: { ...row, status: 'SUBMITTED' },
            result: { status: 'SUCCESS', contractId: 'CSOMEONEELSE' },
            succeeded: true,
          }),
      );
      await service.fund(payment(), BUYER);
      expect(lifecycle.deployed).toHaveBeenCalledWith(ID, CONTRACT);
    });

    it('adopts a deploy a previous call already landed instead of deploying twice', async () => {
      // The earlier call bound the buyer, deployed, and died before it stored the contract.
      const bound = payment({ buyerAddress: BUYER });
      const { service, client, transactions, lifecycle } = setup(bound);
      (transactions.latest as jest.Mock).mockResolvedValueOnce({
        status: 'SUBMITTED',
        result: { status: 'SUCCESS' },
        context: { contractId: CONTRACT },
        expiresAt: new Date(),
      });
      await service.fund(bound, BUYER);
      expect(client.deploy).not.toHaveBeenCalled();
      expect(lifecycle.deployed).toHaveBeenCalledWith(ID, CONTRACT);
    });

    it('answers 502 and keeps no contract when the deploy does not land', async () => {
      const { service, transactions, lifecycle } = setup(payment());
      (transactions.relayServerSigned as jest.Mock).mockImplementationOnce(
        (row: object) =>
          Promise.resolve({
            row,
            result: { status: 'FAILED', message: 'tx_insufficient_balance' },
            succeeded: false,
          }),
      );
      const error = await refusal(service.fund(payment(), BUYER));
      expect(error.getStatus()).toBe(502);
      expect(error.message).toMatch(/tx_insufficient_balance/);
      expect(lifecycle.deployed).not.toHaveBeenCalled();
    });
  });

  describe('the parties’ builds', () => {
    const funded = payment({
      status: 'FUNDED',
      buyerAddress: BUYER,
      contractId: CONTRACT,
    });

    it('builds the approval for the party the model names, and refuses the other', async () => {
      const { service, client } = setup(funded);
      await service.approve(funded, 'BUYER');
      expect(client.approveMilestone).toHaveBeenCalledWith('testnet', {
        contractId: CONTRACT,
        milestoneIndex: '0',
        approver: BUYER,
      });
      expect((await refusal(service.approve(funded, 'MERCHANT'))).code).toBe(
        ApiErrorCode.InvalidStateTransition,
      );
    });

    it('hands a role holder its own dispute to sign', async () => {
      const { service, client, transactions } = setup(funded);
      const outcome = await service.dispute(funded, 'BUYER', 'never arrived');
      expect(outcome.built?.xdr).toBe('DISPUTE_XDR');
      expect(client.disputeEscrow).toHaveBeenCalledWith('testnet', {
        contractId: CONTRACT,
        signer: BUYER,
      });
      expect(transactions.relayServerSigned).not.toHaveBeenCalled();
    });

    describe('a buyer without a role (MERCHANT_RELEASES)', () => {
      const merchantReleases = {
        ...funded,
        releaseModel: 'MERCHANT_RELEASES' as const,
      };

      it('needs a signed challenge before the platform spends anything', async () => {
        const { service, client } = setup(merchantReleases);
        const error = await refusal(
          service.dispute(merchantReleases, 'BUYER', null),
        );
        expect(error.code).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
        const forged = await refusal(
          service.dispute(merchantReleases, 'BUYER', null, {
            signature: Buffer.alloc(64, 1).toString('base64'),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
        expect(forged.code).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
        expect(client.disputeEscrow).not.toHaveBeenCalled();
      });

      it('has the platform open it once the buyer signed the challenge', async () => {
        const { service, client, transactions, lifecycle } =
          setup(merchantReleases);
        const { message, expiresAt } = disputeChallenge(
          { protectedPaymentId: ID, buyer: BUYER, network: 'testnet' },
          new Date(),
        );
        const signature = Buffer.from(
          buyerKey.sign(Buffer.from(message, 'utf8')),
        ).toString('base64');

        const outcome = await service.dispute(
          merchantReleases,
          'BUYER',
          'damaged',
          {
            signature,
            expiresAt,
          },
        );

        expect(client.disputeEscrow).toHaveBeenCalledWith('testnet', {
          contractId: CONTRACT,
          signer: platform.publicKey(),
        });
        expect(transactions.relayServerSigned).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'DISPUTE' }),
          platform,
        );
        expect(lifecycle.step).toHaveBeenCalledWith(
          ID,
          'DISPUTED',
          { disputedBy: 'BUYER', disputeReason: 'damaged' },
          expect.any(Date),
        );
        expect(outcome.submitted?.status).toBe('SUCCESS');
      });
    });
  });

  describe('resolve', () => {
    const disputed = payment({
      status: 'DISPUTED',
      buyerAddress: BUYER,
      contractId: CONTRACT,
    });

    it('signs with the automatic resolver and relays at once', async () => {
      const { service, client, transactions } = setup(disputed);
      const outcome = await service.resolve(
        disputed,
        { buyer: 1_255_000_000n, merchant: 0n },
        'DEADLINE',
      );
      expect(client.resolveDispute).toHaveBeenCalledWith('testnet', {
        contractId: CONTRACT,
        disputeResolver: resolver.publicKey(),
        distributions: [{ address: BUYER, amount: 125.5 }],
      });
      expect(transactions.relayServerSigned).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESOLVE' }),
        resolver,
      );
      expect(outcome.submitted).toBeDefined();
    });

    it('hands an ops-resolved payment the envelope for the ops wallet', async () => {
      const manual = { ...disputed, disputeResolverAddress: OPS };
      const { service, transactions } = setup(manual);
      const outcome = await service.resolve(
        manual,
        { buyer: 1_000_000_000n, merchant: 255_000_000n },
        'ops@cosmospay.lat',
      );
      expect(outcome.built?.xdr).toBe('RESOLVE_XDR');
      expect(transactions.relayServerSigned).not.toHaveBeenCalled();
    });

    it("refuses a split that is not the contract's balance", async () => {
      const { service, client } = setup(disputed);
      const error = await refusal(
        service.resolve(disputed, { buyer: 1n, merchant: 1n }, 'ops'),
      );
      expect(error.code).toBe(ApiErrorCode.InvalidAmount);
      expect(client.resolveDispute).not.toHaveBeenCalled();
    });
  });

  it('applies a landed fund: FUNDED, with the delivery deadline from now', async () => {
    const awaiting = payment({
      status: 'AWAITING_FUNDING',
      buyerAddress: BUYER,
      contractId: CONTRACT,
    });
    const { service, lifecycle } = setup(awaiting);
    const before = Date.now();
    await service.apply(awaiting, {
      row: { action: 'FUND', txHash: 'h', context: null } as never,
      result: { status: 'SUCCESS' },
      succeeded: true,
    });
    const [, step, data] = (lifecycle.step as jest.Mock).mock.calls[0] as [
      string,
      string,
      { deliveryDeadlineAt: Date },
    ];
    expect(step).toBe('FUNDED');
    expect(data.deliveryDeadlineAt.getTime()).toBeGreaterThanOrEqual(
      before + 168 * 3_600_000,
    );
  });

  it('applies nothing when Trustless Work answered FAILED', async () => {
    const { service, lifecycle, prisma } = setup(payment());
    (prisma.protectedPayment.findUniqueOrThrow as jest.Mock).mockClear();
    const answer = await service.apply(payment(), {
      row: { action: 'SHIP', txHash: 'h', context: null } as never,
      result: { status: 'FAILED', message: 'nope' },
      succeeded: false,
    });
    expect(lifecycle.step).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ status: 'FAILED', message: 'nope' });
  });
});
