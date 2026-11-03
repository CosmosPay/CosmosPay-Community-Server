import type {
  ProtectedPaymentAction,
  ProtectedPaymentStatus,
  WebhookEventType,
} from '@generated/prisma/client';

/**
 * Executable spec for the protected payment state machine. Pure: the lifecycle
 * service applies these rules as compare-and-swap writes, and the spec pins
 * them. Status names match the Prisma `ProtectedPaymentStatus` enum.
 *
 * The chain is authoritative: the sync job moves a payment to whatever its
 * contract shows, and between two reads a contract can go further than one
 * step (funded and released, disputed and resolved). So the graph allows every
 * forward jump the contract can make, and nothing backwards.
 */
export const PROTECTED_PAYMENT_TRANSITIONS: Record<
  ProtectedPaymentStatus,
  readonly ProtectedPaymentStatus[]
> = {
  CREATED: ['AWAITING_FUNDING', 'EXPIRED', 'CANCELLED'],
  AWAITING_FUNDING: [
    'FUNDED',
    'SHIPPED',
    'APPROVED',
    'RELEASED',
    'DISPUTED',
    'RESOLVED',
    'EXPIRED',
    'CANCELLED',
  ],
  FUNDED: ['SHIPPED', 'APPROVED', 'RELEASED', 'DISPUTED', 'RESOLVED'],
  SHIPPED: ['APPROVED', 'RELEASED', 'DISPUTED', 'RESOLVED'],
  APPROVED: ['RELEASED', 'DISPUTED', 'RESOLVED'],
  DISPUTED: ['RESOLVED'],
  RELEASED: [],
  RESOLVED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** The statuses nothing leaves. Their webhook events are terminal too. */
export const TERMINAL_PROTECTED_PAYMENT_STATUSES = [
  'RELEASED',
  'RESOLVED',
  'EXPIRED',
  'CANCELLED',
] as const satisfies readonly ProtectedPaymentStatus[];

/** Every status the sync job reads back from a contract. */
export const OPEN_PROTECTED_PAYMENT_STATUSES = [
  'AWAITING_FUNDING',
  'FUNDED',
  'SHIPPED',
  'APPROVED',
  'DISPUTED',
] as const satisfies readonly ProtectedPaymentStatus[];

/** Funded and not settled: what a delivery deadline applies to. */
export const IN_DELIVERY_STATUSES = [
  'FUNDED',
  'SHIPPED',
  'APPROVED',
] as const satisfies readonly ProtectedPaymentStatus[];

export function canTransition(
  from: ProtectedPaymentStatus,
  to: ProtectedPaymentStatus,
): boolean {
  return PROTECTED_PAYMENT_TRANSITIONS[from].includes(to);
}

/** The statuses `to` may be reached from. */
export function statusesReaching(
  to: ProtectedPaymentStatus,
): ProtectedPaymentStatus[] {
  return (
    Object.keys(PROTECTED_PAYMENT_TRANSITIONS) as ProtectedPaymentStatus[]
  ).filter((from) => canTransition(from, to));
}

export function isTerminal(status: ProtectedPaymentStatus): boolean {
  return (TERMINAL_PROTECTED_PAYMENT_STATUSES as readonly string[]).includes(
    status,
  );
}

/**
 * The statuses a party may BUILD each action from: what this service hands
 * out to sign. Stricter than the graph, which also has to accept what the
 * chain did on its own.
 */
export const ACTION_BUILDABLE_FROM: Record<
  ProtectedPaymentAction,
  readonly ProtectedPaymentStatus[]
> = {
  DEPLOY: ['CREATED'],
  FUND: ['CREATED', 'AWAITING_FUNDING'],
  SHIP: ['FUNDED'],
  APPROVE: ['FUNDED', 'SHIPPED'],
  RELEASE: ['APPROVED'],
  DISPUTE: ['FUNDED', 'SHIPPED', 'APPROVED'],
  RESOLVE: ['DISPUTED'],
};

export function canBuild(
  action: ProtectedPaymentAction,
  status: ProtectedPaymentStatus,
): boolean {
  return ACTION_BUILDABLE_FROM[action].includes(status);
}

/**
 * One step of a protected payment's life: the timestamp column that records
 * it (written once, which is what makes every step idempotent), the status it
 * moves to (null: the status stays), and the webhook it emits.
 */
export interface LifecycleStep {
  stamp:
    | 'fundedAt'
    | 'shippedAt'
    | 'approvedAt'
    | 'releasedAt'
    | 'disputedAt'
    | 'resolvedAt'
    | 'cancelledAt'
    | 'deadlinePassedAt'
    | null;
  to: ProtectedPaymentStatus | null;
  event: WebhookEventType;
}

export type LifecycleStepName =
  | 'FUNDED'
  | 'SHIPPED'
  | 'APPROVED'
  | 'RELEASED'
  | 'DISPUTED'
  | 'RESOLVED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'DEADLINE_PASSED';

export const LIFECYCLE_STEPS: Record<LifecycleStepName, LifecycleStep> = {
  FUNDED: {
    stamp: 'fundedAt',
    to: 'FUNDED',
    event: 'PROTECTED_PAYMENT_FUNDED',
  },
  SHIPPED: {
    stamp: 'shippedAt',
    to: 'SHIPPED',
    event: 'PROTECTED_PAYMENT_SHIPPED',
  },
  APPROVED: {
    stamp: 'approvedAt',
    to: 'APPROVED',
    event: 'PROTECTED_PAYMENT_APPROVED',
  },
  RELEASED: {
    stamp: 'releasedAt',
    to: 'RELEASED',
    event: 'PROTECTED_PAYMENT_RELEASED',
  },
  DISPUTED: {
    stamp: 'disputedAt',
    to: 'DISPUTED',
    event: 'PROTECTED_PAYMENT_DISPUTED',
  },
  RESOLVED: {
    stamp: 'resolvedAt',
    to: 'RESOLVED',
    event: 'PROTECTED_PAYMENT_RESOLVED',
  },
  // No column of its own: EXPIRED is terminal, so the status guard is enough.
  EXPIRED: { stamp: null, to: 'EXPIRED', event: 'PROTECTED_PAYMENT_EXPIRED' },
  CANCELLED: {
    stamp: 'cancelledAt',
    to: 'CANCELLED',
    event: 'PROTECTED_PAYMENT_CANCELLED',
  },
  // Marks the payment and notifies once; the status stays where it is.
  DEADLINE_PASSED: {
    stamp: 'deadlinePassedAt',
    to: null,
    event: 'PROTECTED_PAYMENT_DEADLINE_PASSED',
  },
};

/** The statuses a step may be taken from. */
export function stepFrom(step: LifecycleStep): ProtectedPaymentStatus[] {
  return step.to ? statusesReaching(step.to) : [...IN_DELIVERY_STATUSES];
}

/** The step a landed transaction of `action` takes (the deploy has its own write). */
export const ACTION_STEP: Record<
  Exclude<ProtectedPaymentAction, 'DEPLOY'>,
  LifecycleStepName
> = {
  FUND: 'FUNDED',
  SHIP: 'SHIPPED',
  APPROVE: 'APPROVED',
  RELEASE: 'RELEASED',
  DISPUTE: 'DISPUTED',
  RESOLVE: 'RESOLVED',
};
