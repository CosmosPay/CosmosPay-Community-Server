import type {
  ProtectedPaymentDeadlinePolicy,
  ProtectedPaymentReleaseModel,
} from '@generated/prisma/client';
import type { ContractRoles } from '@/native-plugins/trustless-work/trustless-work-envelope';

/**
 * Who holds which role in a protected payment's contract. Pure: the release
 * model (chosen by the merchant per payment) decides who approves the
 * milestone and who releases the funds; the merchant always provides the
 * service and receives the money; the platform is Cosmos Pay; the dispute
 * resolver follows the deadline policy.
 */

/** The two parties of a protected payment. */
export type Party = 'BUYER' | 'MERCHANT';

/**
 * The release model's table (product owner, 2026-11-02). A `Record` over the
 * enum, so a new model does not compile until it says who does what.
 *
 *  - BUYER_RELEASES: cash on delivery. The buyer confirms receipt and releases:
 *    two signatures in V1, approve and then release.
 *  - MERCHANT_RELEASES: the merchant approves and releases when it ships. The
 *    buyer holds no role at all; the platform opens a buyer's dispute.
 *  - BUYER_APPROVES_MERCHANT_RELEASES: the buyer confirms receipt and the
 *    merchant collects.
 */
export const RELEASE_MODEL_ROLES: Record<
  ProtectedPaymentReleaseModel,
  { approver: Party; releaseSigner: Party }
> = {
  BUYER_RELEASES: { approver: 'BUYER', releaseSigner: 'BUYER' },
  MERCHANT_RELEASES: { approver: 'MERCHANT', releaseSigner: 'MERCHANT' },
  BUYER_APPROVES_MERCHANT_RELEASES: {
    approver: 'BUYER',
    releaseSigner: 'MERCHANT',
  },
};

/** The accounts a protected payment's roles are filled from. */
export interface RoleAccounts {
  buyer: string;
  merchant: string;
  platform: string;
  disputeResolver: string;
}

/** The contract's six roles for `model`, filled from `accounts`. */
export function contractRoles(
  model: ProtectedPaymentReleaseModel,
  accounts: RoleAccounts,
): ContractRoles {
  const parties = RELEASE_MODEL_ROLES[model];
  const of = (party: Party) =>
    party === 'BUYER' ? accounts.buyer : accounts.merchant;
  return {
    approver: of(parties.approver),
    serviceProvider: accounts.merchant,
    platform: accounts.platform,
    releaseSigner: of(parties.releaseSigner),
    disputeResolver: accounts.disputeResolver,
    receiver: accounts.merchant,
  };
}

/** Whether `party` approves the milestone under `model`. */
export function approvesUnder(
  model: ProtectedPaymentReleaseModel,
  party: Party,
): boolean {
  return RELEASE_MODEL_ROLES[model].approver === party;
}

/** Whether `party` releases the funds under `model`. */
export function releasesUnder(
  model: ProtectedPaymentReleaseModel,
  party: Party,
): boolean {
  return RELEASE_MODEL_ROLES[model].releaseSigner === party;
}

/**
 * Whether `party` holds a role in the contract, and so may open a dispute by
 * signing it: the merchant always does (service provider, receiver); the buyer
 * only where it approves or releases. A buyer without a role asks the platform
 * to open it, proving its key with a signed message.
 */
export function holdsRole(
  model: ProtectedPaymentReleaseModel,
  party: Party,
): boolean {
  return (
    party === 'MERCHANT' ||
    approvesUnder(model, party) ||
    releasesUnder(model, party)
  );
}

/**
 * Who the deadline policy settles a funded payment for when its delivery
 * deadline passes: nobody (ops reviews it), the buyer (a full refund, net of
 * the fees) or the merchant (the release).
 */
export const DEADLINE_POLICY_BENEFICIARY: Record<
  ProtectedPaymentDeadlinePolicy,
  Party | null
> = {
  MANUAL_REVIEW: null,
  REFUND_BUYER: 'BUYER',
  RELEASE_MERCHANT: 'MERCHANT',
};

/** Whether this policy's resolver is the server's automatic resolver key. */
export function resolvesAutomatically(
  policy: ProtectedPaymentDeadlinePolicy,
): boolean {
  return DEADLINE_POLICY_BENEFICIARY[policy] !== null;
}
