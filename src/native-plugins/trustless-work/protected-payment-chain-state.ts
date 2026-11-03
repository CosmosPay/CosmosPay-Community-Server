import type { ProtectedPayment } from '@generated/prisma/client';
import type { TrustlessWorkContractRead } from '@/native-plugins/trustless-work/trustless-work.client';
import { PROTECTED_PAYMENT_SHIPPED_STATUS } from '@/native-plugins/trustless-work/trustless-work.constants';
import { balanceStroops } from '@/native-plugins/trustless-work/protected-payment-math';
import type { LifecycleStepName } from '@/native-plugins/trustless-work/protected-payment-transitions';

/**
 * What a contract says about its protected payment, read from Trustless Work's
 * answer (checked against the chain with `validateOnChain=true`). Pure.
 */
export interface ChainState {
  /** USDC in the contract, in stroops; null when the answer has no balance. */
  balance: bigint | null;
  funded: boolean;
  shipped: boolean;
  evidence: string | null;
  approved: boolean;
  disputed: boolean;
  released: boolean;
  resolved: boolean;
}

/**
 * The contract's state. Funded is a balance above zero, or a contract already
 * released or resolved (both leave it empty). Shipped is the milestone carrying
 * the shipped status or any evidence. A missing field reads as "not yet".
 */
export function chainStateOf(read: TrustlessWorkContractRead): ChainState {
  const milestone = Array.isArray(read.milestones)
    ? read.milestones[0]
    : undefined;
  const flags = read.flags ?? {};
  const balance = balanceStroops(read.balance);
  const released = flags.released === true;
  const resolved = flags.resolved === true;
  const evidence =
    typeof milestone?.evidence === 'string' && milestone.evidence !== ''
      ? milestone.evidence
      : null;
  return {
    balance,
    funded: (balance !== null && balance > 0n) || released || resolved,
    shipped:
      evidence !== null ||
      (typeof milestone?.status === 'string' &&
        milestone.status.toLowerCase() === PROTECTED_PAYMENT_SHIPPED_STATUS),
    evidence,
    approved: milestone?.approved === true,
    disputed: flags.disputed === true,
    released,
    resolved,
  };
}

/**
 * The steps the row has not taken yet that the contract has, in the order they
 * happen. Each is then a compare-and-swap of its own (`ProtectedPaymentLifecycle`),
 * so a step another writer took meanwhile is simply skipped.
 */
export function chainSteps(
  row: Pick<
    ProtectedPayment,
    | 'fundedAt'
    | 'shippedAt'
    | 'approvedAt'
    | 'disputedAt'
    | 'releasedAt'
    | 'resolvedAt'
  >,
  state: ChainState,
): LifecycleStepName[] {
  const steps: LifecycleStepName[] = [];
  if (state.funded && !row.fundedAt) steps.push('FUNDED');
  if (state.shipped && !row.shippedAt) steps.push('SHIPPED');
  if (state.approved && !row.approvedAt) steps.push('APPROVED');
  if (state.disputed && !row.disputedAt) steps.push('DISPUTED');
  if (state.released && !row.releasedAt) steps.push('RELEASED');
  if (state.resolved && !row.resolvedAt) steps.push('RESOLVED');
  return steps;
}
