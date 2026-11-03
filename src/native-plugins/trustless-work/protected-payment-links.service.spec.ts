import { Keypair } from '@stellar/stellar-sdk';
import type { ProtectedPayment } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { PrismaService } from '@/prisma/prisma.service';
import type { ProtectedPaymentActionsService } from '@/native-plugins/trustless-work/protected-payment-actions.service';
import { ProtectedPaymentLinksService } from '@/native-plugins/trustless-work/protected-payment-links.service';

const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const BUYER = Keypair.random().publicKey();
const MERCHANT = Keypair.random().publicKey();

function row(overrides: Partial<ProtectedPayment> = {}): ProtectedPayment {
  return {
    id: ID,
    consumerId: 'local_merchant',
    network: 'testnet',
    status: 'CREATED',
    releaseModel: 'BUYER_RELEASES',
    deadlinePolicy: 'MANUAL_REVIEW',
    title: 'Order #1042',
    description: null,
    reference: 'internal-ref-77',
    amount: '125.5',
    asset: 'USDC',
    assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    merchantAddress: MERCHANT,
    buyerAddress: null,
    platformAddress: Keypair.random().publicKey(),
    disputeResolverAddress: Keypair.random().publicKey(),
    platformFeeBps: 165,
    contractId: null,
    idempotencyKey: 'key-1',
    fundingExpiresAt: new Date(Date.now() + 3_600_000),
    deliveryWindowHours: 168,
    deliveryDeadlineAt: null,
    deadlinePassedAt: null,
    evidence: null,
    fundedAt: null,
    shippedAt: null,
    approvedAt: null,
    releasedAt: null,
    disputedAt: null,
    disputedBy: null,
    disputeReason: 'the merchant wrote this',
    resolvedAt: null,
    resolution: null,
    cancelledAt: null,
    deployClaimedAt: null,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(stored: ProtectedPayment | null = row()) {
  const findUnique = jest.fn().mockResolvedValue(stored);
  const prisma = {
    protectedPayment: { findUnique },
  } as unknown as PrismaService;
  const actions = {
    fund: jest.fn((payment: ProtectedPayment) =>
      Promise.resolve({
        action: 'FUND',
        xdr: 'AAAA',
        txHash: 'ab',
        expiresAt: new Date(),
        payment: {
          ...payment,
          buyerAddress: BUYER,
          status: 'AWAITING_FUNDING',
        },
      }),
    ),
    submit: jest.fn(),
  } as unknown as ProtectedPaymentActionsService;
  return {
    service: new ProtectedPaymentLinksService(prisma, actions),
    findUnique,
    actions,
  };
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

describe('ProtectedPaymentLinksService', () => {
  it('answers an id that is not a uuid with 404, before the table is read', async () => {
    const { service, findUnique } = setup();
    for (const id of ['1', 'cmh4x2k9a0001l70g8v5q3z2w', `${ID}x`, "' OR 1=1"]) {
      const error = await refusal(service.findPublic(id));
      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe(ApiErrorCode.NotFound);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('answers an unknown id with the same 404', async () => {
    const { service } = setup(null);
    expect((await refusal(service.findPublic(ID))).getStatus()).toBe(404);
  });

  it('loads the row by its id alone: the id is the capability', async () => {
    const { service, findUnique } = setup();
    await service.findPublic(ID);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: ID } });
  });

  it("answers the buyer's projection, never the merchant's consumer, reference or internals", async () => {
    const { service } = setup();
    const view = await service.findPublic(ID);
    for (const key of [
      'consumerId',
      'reference',
      'idempotencyKey',
      'disputeReason',
      'disputedBy',
      'platformAddress',
      'disputeResolverAddress',
      'deployClaimedAt',
      'lastSyncedAt',
      'checkoutUrl',
    ]) {
      expect(view).not.toHaveProperty(key);
    }
    expect(view).toMatchObject({
      id: ID,
      amount: '125.5',
      merchantAddress: MERCHANT,
      buyerActions: ['fund'],
      disputeChallenge: null,
      fees: { totalBps: 195, merchantReceives: '123.05275' },
    });
  });

  it('offers what the buyer may do by the release model', async () => {
    const funded = {
      status: 'FUNDED' as const,
      buyerAddress: BUYER,
      contractId: 'C',
    };
    expect(
      (await setup(row(funded)).service.findPublic(ID)).buyerActions,
    ).toEqual(['approve', 'dispute']);
    expect(
      (
        await setup(row({ ...funded, status: 'APPROVED' })).service.findPublic(
          ID,
        )
      ).buyerActions,
    ).toEqual(['release', 'dispute']);
    const merchantReleases = await setup(
      row({ ...funded, releaseModel: 'MERCHANT_RELEASES' }),
    ).service.findPublic(ID);
    expect(merchantReleases.buyerActions).toEqual(['dispute']);
    // The buyer holds no role, so the platform opens it: the page signs this.
    expect(merchantReleases.disputeChallenge?.message).toContain(
      `account: ${BUYER}`,
    );
  });

  it('offers no fund once the funding window closed', async () => {
    const { service } = setup(
      row({ fundingExpiresAt: new Date(Date.now() - 1) }),
    );
    expect((await service.findPublic(ID)).buyerActions).toEqual([]);
  });

  it('builds the fund for the buyer and answers the buyer view', async () => {
    const { service, actions } = setup();
    const built = await service.fund(ID, BUYER);
    expect(actions.fund).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID }),
      BUYER,
    );
    expect(built.protectedPayment).not.toHaveProperty('consumerId');
    expect(built.protectedPayment.buyerAddress).toBe(BUYER);
  });

  it('relays nothing for a payment no buyer is bound to', async () => {
    const { service, actions } = setup();
    expect((await refusal(service.submit(ID, 'AAAA'))).getStatus()).toBe(404);
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
