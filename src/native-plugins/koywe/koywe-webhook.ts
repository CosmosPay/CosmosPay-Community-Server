import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StellarNetwork } from '@/config/configuration';
import { decimalString } from '@/native-plugins/koywe/bank-transfer';
import {
  KOYWE_EVENT_ID_MAX,
  KOYWE_ORDER_ON_HOLD,
  KOYWE_POLICY_ALLOW,
  KOYWE_SIGNATURE_RE,
  KOYWE_WEBHOOK_NETWORKS,
} from '@/native-plugins/koywe/koywe.constants';

/**
 * The provider's webhook, read: its signature, its envelope and the parts of
 * `data` this plugin uses. Pure. The `data` of a deposit is undocumented, so
 * every field is read from each place it may be in, and a missing one is
 * reported by its key names only (a value may be a document number).
 */

/** Whether `signature` is the lowercase hex HMAC-SHA256 of `raw` under `secret`, compared in constant time. */
export function signatureMatches(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signature || !KOYWE_SIGNATURE_RE.test(signature.trim())) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(signature.trim().toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The network whose webhook secret signed `raw`, or null: every configured
 * secret is checked (never stopping early on a match), and the one that
 * verifies decides which network's records the delivery may touch.
 */
export function verifyingNetwork(
  raw: Buffer,
  signature: string | undefined,
  secrets: Readonly<Record<StellarNetwork, string>>,
): StellarNetwork | null {
  let found: StellarNetwork | null = null;
  for (const network of KOYWE_WEBHOOK_NETWORKS) {
    if (signatureMatches(raw, signature, secrets[network]) && !found) {
      found = network;
    }
  }
  return found;
}

/** A delivery's envelope, as far as this plugin reads it. */
export interface KoyweEnvelope {
  id: string;
  type: string;
  /** `production`, `sandbox`, ... as the provider says. */
  environment: string | null;
  organizationId: string | null;
  merchantId: string | null;
  data: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The envelope of a parsed body, or null when it has no usable `id` and `type`. */
export function readEnvelope(body: unknown): KoyweEnvelope | null {
  if (!isObject(body)) return null;
  const id = text(body.id);
  const type = text(body.type);
  if (!id || id.length > KOYWE_EVENT_ID_MAX || !type) return null;
  return {
    id,
    type,
    environment: text(body.environment),
    organizationId: text(body.organization_id),
    merchantId: text(body.merchant_id),
    data: isObject(body.data) ? body.data : {},
  };
}

/** The first of `paths` (dotted) that holds a value in `data`. */
function first(data: Record<string, unknown>, paths: readonly string[]) {
  for (const path of paths) {
    let value: unknown = data;
    for (const key of path.split('.')) {
      value = isObject(value) ? value[key] : undefined;
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const AMOUNT_PATHS = ['amount', 'amountIn'] as const;
const CURRENCY_PATHS = ['currency', 'currencySymbol'] as const;
const DOCUMENT_PATHS = [
  'documentNumber',
  'depositor.documentNumber',
  'payer.documentNumber',
  'customer.documentNumber',
] as const;
const REFERENCE_PATHS = ['referenceId', 'id'] as const;

/** A deposit (`bank_income.received`), as far as it could be read. */
export interface BankIncome {
  /** A decimal string, or null. */
  amount: string | null;
  /** Upper case, or null. */
  currency: string | null;
  /** The depositor's document as the provider sent it (never logged). */
  document: unknown;
  reference: string | null;
  /** Which of the four could not be read, for the log. */
  missing: string[];
}

export function readBankIncome(data: Record<string, unknown>): BankIncome {
  const amount = decimalString(first(data, AMOUNT_PATHS));
  const currency = text(first(data, CURRENCY_PATHS))?.toUpperCase() ?? null;
  const document = first(data, DOCUMENT_PATHS);
  const rawReference = first(data, REFERENCE_PATHS);
  const reference =
    typeof rawReference === 'number'
      ? String(rawReference)
      : text(rawReference);
  const missing = [
    amount === null ? 'amount' : null,
    currency === null ? 'currency' : null,
    document === undefined ? 'document' : null,
    reference === null ? 'reference' : null,
  ].filter((name): name is string => name !== null);
  return { amount, currency, document, reference, missing };
}

/**
 * The key names of `data`, one level into its objects, never a value: what a
 * log may say about a payload it could not read.
 */
export function keyNames(data: Record<string, unknown>): string {
  return (
    Object.entries(data)
      .map(([key, value]) =>
        isObject(value) ? `${key}{${Object.keys(value).join(',')}}` : key,
      )
      .join(', ') || '(none)'
  );
}

const TX_HASH_PATHS = [
  'txHash',
  'transactionHash',
  'hash',
  'transferInfo.txHash',
  'transferInfo.transactionHash',
  'transferInfo.hash',
  'blockchain.txHash',
  'blockchain.transactionHash',
  'blockchain.hash',
] as const;

/** An order (an event's `data`, or `GET orders/{id}`), as far as it could be read. */
export interface KoyweOrderState {
  orderId: string | null;
  externalId: string | null;
  type: string | null;
  /** Upper case, or null. */
  status: string | null;
  /** The token delivered, a decimal string, or null. */
  amountOut: string | null;
  txHash: string | null;
  policyResult: string | null;
  pendingApprovalId: string | null;
}

export function readOrder(raw: unknown): KoyweOrderState {
  const data = isObject(raw) ? raw : {};
  return {
    orderId: text(first(data, ['orderId', 'id'])),
    externalId: text(data.externalId),
    type: text(data.type)?.toUpperCase() ?? null,
    status: text(data.status)?.toUpperCase() ?? null,
    amountOut: decimalString(first(data, ['amountOut'])),
    txHash: text(first(data, TX_HASH_PATHS)),
    policyResult: text(data.policyResult)?.toUpperCase() ?? null,
    pendingApprovalId: text(data.pendingApprovalId),
  };
}

/** Two reads of one order, the second (the provider's own) filling what the first lacks. */
export function mergeOrders(
  event: KoyweOrderState,
  read: KoyweOrderState,
): KoyweOrderState {
  return {
    orderId: read.orderId ?? event.orderId,
    externalId: read.externalId ?? event.externalId,
    type: read.type ?? event.type,
    status: read.status ?? event.status,
    amountOut: read.amountOut ?? event.amountOut,
    txHash: read.txHash ?? event.txHash,
    policyResult: read.policyResult ?? event.policyResult,
    pendingApprovalId: read.pendingApprovalId ?? event.pendingApprovalId,
  };
}

/** A KYB event's `data`: the process, and the reason when it was rejected. */
export function readKybEvent(data: Record<string, unknown>): {
  merchantId: string | null;
  kybId: string | null;
  reason: string | null;
} {
  return {
    merchantId: text(data.merchantId),
    kybId: text(first(data, ['kybId', 'kybProcessId', 'id'])),
    reason: text(first(data, ['statusReason', 'reason', 'rejectionReason'])),
  };
}

/**
 * Why an order is waiting for a person, or null: an approval policy answer
 * other than ALLOW, or the order held. Ops must approve it (or add a policy
 * rule that allows ONRAMP orders for the API user).
 */
export function holdReason(order: KoyweOrderState): string | null {
  const approval = order.pendingApprovalId
    ? ` (${order.pendingApprovalId})`
    : '';
  if (order.policyResult && order.policyResult !== KOYWE_POLICY_ALLOW) {
    return `approval policy ${order.policyResult}${approval}`;
  }
  if (order.status === KOYWE_ORDER_ON_HOLD) return `order on hold${approval}`;
  return null;
}
