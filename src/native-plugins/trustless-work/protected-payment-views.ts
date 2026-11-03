import type { Prisma, ProtectedPayment } from '@generated/prisma/client';
import { project } from '@/common/projection';
import type { StellarNetwork } from '@/config/configuration';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import { TRUSTLESS_WORK_FEE_BPS } from '@/native-plugins/trustless-work/trustless-work.constants';
import { disputeChallenge } from '@/native-plugins/trustless-work/protected-payment-dispute-challenge';
import {
  feeSplit,
  totalFeeBps,
} from '@/native-plugins/trustless-work/protected-payment-math';
import {
  approvesUnder,
  holdsRole,
  releasesUnder,
} from '@/native-plugins/trustless-work/protected-payment-roles';
import { canBuild } from '@/native-plugins/trustless-work/protected-payment-transitions';

/**
 * What a protected payment looks like to the two people who read it. Pure.
 *
 * Both projections are allowlists over the row, applied with `project`, so a
 * column added later leaves this service only when it is named here.
 */

/**
 * The merchant's view (`GET /v1/protected-payments/{id}`, the list, the
 * webhooks): everything but the consumer, the idempotency key and the
 * internal claim column.
 */
export const PROTECTED_PAYMENT_PUBLIC_SELECT = {
  id: true,
  network: true,
  status: true,
  releaseModel: true,
  deadlinePolicy: true,
  title: true,
  description: true,
  reference: true,
  amount: true,
  asset: true,
  assetIssuer: true,
  merchantAddress: true,
  buyerAddress: true,
  platformAddress: true,
  disputeResolverAddress: true,
  platformFeeBps: true,
  contractId: true,
  fundingExpiresAt: true,
  deliveryWindowHours: true,
  deliveryDeadlineAt: true,
  deadlinePassedAt: true,
  evidence: true,
  fundedAt: true,
  shippedAt: true,
  approvedAt: true,
  releasedAt: true,
  disputedAt: true,
  disputedBy: true,
  disputeReason: true,
  resolvedAt: true,
  resolution: true,
  cancelledAt: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ProtectedPaymentSelect;

/**
 * The buyer's view (`GET /v1/protected-payment-links/{id}`, keyless). Narrower:
 * never the merchant's consumer, its `reference`, the dispute's reason (the
 * merchant may have written it), the internal columns or a provider payload.
 */
export const PROTECTED_PAYMENT_LINK_SELECT = {
  id: true,
  network: true,
  status: true,
  releaseModel: true,
  deadlinePolicy: true,
  title: true,
  description: true,
  amount: true,
  asset: true,
  assetIssuer: true,
  merchantAddress: true,
  buyerAddress: true,
  platformFeeBps: true,
  contractId: true,
  fundingExpiresAt: true,
  deliveryWindowHours: true,
  deliveryDeadlineAt: true,
  deadlinePassedAt: true,
  evidence: true,
  fundedAt: true,
  shippedAt: true,
  approvedAt: true,
  releasedAt: true,
  disputedAt: true,
  resolvedAt: true,
  resolution: true,
  cancelledAt: true,
  createdAt: true,
} as const satisfies Prisma.ProtectedPaymentSelect;

/** What the fees take, as both parties see them. */
export interface ProtectedPaymentFees {
  trustlessWorkBps: number;
  platformBps: number;
  totalBps: number;
  /** What the merchant receives on a release, after both fees. */
  merchantReceives: string;
}

/** What the buyer can do from the payment link right now. */
export type BuyerAction = 'fund' | 'approve' | 'release' | 'dispute';

export type MerchantView = Pick<
  ProtectedPayment,
  keyof typeof PROTECTED_PAYMENT_PUBLIC_SELECT
> & { fees: ProtectedPaymentFees; checkoutUrl: string };

export type BuyerView = Pick<
  ProtectedPayment,
  keyof typeof PROTECTED_PAYMENT_LINK_SELECT
> & {
  fees: ProtectedPaymentFees;
  buyerActions: BuyerAction[];
  /**
   * The message the buyer signs to have the platform open a dispute, when the
   * buyer holds no role in the contract (`MERCHANT_RELEASES`) and may dispute.
   */
  disputeChallenge: { message: string; expiresAt: string } | null;
};

export function fees(
  row: Pick<ProtectedPayment, 'amount' | 'platformFeeBps'>,
): ProtectedPaymentFees {
  const split = feeSplit(toStroops(row.amount), row.platformFeeBps);
  return {
    trustlessWorkBps: TRUSTLESS_WORK_FEE_BPS,
    platformBps: row.platformFeeBps,
    totalBps: totalFeeBps(row.platformFeeBps),
    merchantReceives: fromStroops(split.net),
  };
}

/** The buyer's page: `<payments origin>/protected/<id>`. */
export function checkoutUrl(origin: string, id: string): string {
  return `${origin}/protected/${id}`;
}

/** A row as the merchant's reads load it. */
export type MerchantRow = Pick<
  ProtectedPayment,
  keyof typeof PROTECTED_PAYMENT_PUBLIC_SELECT
>;

export function merchantView(
  row: MerchantRow,
  checkoutOrigin: string,
): MerchantView {
  return {
    ...project(row, PROTECTED_PAYMENT_PUBLIC_SELECT),
    fees: fees(row),
    checkoutUrl: checkoutUrl(checkoutOrigin, row.id),
  };
}

/** What the buyer may do now, from the status and the release model. */
export function buyerActions(row: ProtectedPayment, now: Date): BuyerAction[] {
  const actions: BuyerAction[] = [];
  if (canBuild('FUND', row.status) && now <= row.fundingExpiresAt) {
    actions.push('fund');
  }
  if (!row.buyerAddress) return actions;
  if (
    approvesUnder(row.releaseModel, 'BUYER') &&
    canBuild('APPROVE', row.status)
  ) {
    actions.push('approve');
  }
  if (
    releasesUnder(row.releaseModel, 'BUYER') &&
    canBuild('RELEASE', row.status)
  ) {
    actions.push('release');
  }
  if (canBuild('DISPUTE', row.status)) actions.push('dispute');
  return actions;
}

export function buyerView(row: ProtectedPayment, now: Date): BuyerView {
  const actions = buyerActions(row, now);
  return {
    ...project(row, PROTECTED_PAYMENT_LINK_SELECT),
    fees: fees(row),
    buyerActions: actions,
    disputeChallenge:
      actions.includes('dispute') &&
      row.buyerAddress &&
      !holdsRole(row.releaseModel, 'BUYER')
        ? disputeChallenge(
            {
              protectedPaymentId: row.id,
              buyer: row.buyerAddress,
              network: row.network as StellarNetwork,
            },
            now,
          )
        : null,
  };
}
