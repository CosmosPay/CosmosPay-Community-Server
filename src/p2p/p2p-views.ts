import type { Prisma } from '@generated/prisma/client';
import type {
  P2pMarketAccountEntity,
  P2pMarketPaymentMethodEntity,
} from '@/p2p/entities/p2p-account.entity';
import type {
  P2pCheckoutOrderEntity,
  P2pMarketChargeEntity,
} from '@/p2p/entities/p2p-charge.entity';
import type { P2pMarketOfferEntity } from '@/p2p/entities/p2p-offer.entity';
import type {
  P2pMarketBeneficiaryEntity,
  P2pMarketMerchantOrderEntity,
  P2pMarketOrderEntity,
  P2pMarketOrderSettlementEntity,
  P2pMarketPayerEntity,
  P2pMarketPaymentDetailsEntity,
} from '@/p2p/entities/p2p-order.entity';
import { completionRate } from '@/p2p/p2p-matching';
import {
  P2P_LIVE_STATUSES,
  P2P_MERCHANT_SIDE,
  type P2pOrderKind,
  type P2pOrderStatus,
} from '@/p2p/p2p-order-status';
import { P2P_RAILS, isP2pRailId } from '@/p2p/p2p-rails';

/**
 * The projections every P2P read goes through (`*_SELECT`, an allowlist of
 * columns) and the mappers that turn a row into what its reader may see. The
 * sealed columns are selected only by the services that open them for a
 * reader entitled to them.
 */

export const P2P_ACCOUNT_SELECT = {
  id: true,
  tier: true,
  address: true,
  label: true,
  displayName: true,
  merchantStatus: true,
  completedOrders: true,
  cancelledOrders: true,
  disputesLost: true,
  medianReleaseSeconds: true,
  lastActiveAt: true,
  verifiedAt: true,
  operators: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.P2pAccountSelect;
export type P2pAccountRow = Prisma.P2pAccountGetPayload<{
  select: typeof P2P_ACCOUNT_SELECT;
}>;

export function merchantStats(row: {
  completedOrders: number;
  cancelledOrders: number;
  disputesLost: number;
  medianReleaseSeconds: number | null;
}) {
  return {
    completedOrders: row.completedOrders,
    cancelledOrders: row.cancelledOrders,
    completionRate:
      Math.round(
        completionRate({
          completed: row.completedOrders,
          cancelled: row.cancelledOrders,
        }) * 100,
      ) / 100,
    disputesLost: row.disputesLost,
    medianReleaseSeconds: row.medianReleaseSeconds,
  };
}

export function toAccountView(row: P2pAccountRow): P2pMarketAccountEntity {
  return {
    id: row.id,
    tier: row.tier,
    address: row.address,
    label: row.label,
    displayName: row.displayName,
    merchantStatus: row.merchantStatus,
    stats: merchantStats(row),
    lastActiveAt: row.lastActiveAt,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const P2P_PAYMENT_METHOD_SELECT = {
  id: true,
  accountId: true,
  currency: true,
  rail: true,
  details: true,
  holderName: true,
  label: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.P2pPaymentMethodSelect;
export type P2pPaymentMethodRow = Prisma.P2pPaymentMethodGetPayload<{
  select: typeof P2P_PAYMENT_METHOD_SELECT;
}>;

export function toPaymentMethodView(
  row: P2pPaymentMethodRow,
  opened: { details: Record<string, string>; holderName: string },
): P2pMarketPaymentMethodEntity {
  return {
    id: row.id,
    accountId: row.accountId,
    currency: row.currency,
    rail: row.rail,
    holderName: opened.holderName,
    details: opened.details,
    summary: isP2pRailId(row.rail)
      ? P2P_RAILS[row.rail].summary(opened.details)
      : row.rail,
    label: row.label,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const P2P_OFFER_SELECT = {
  id: true,
  accountId: true,
  tier: true,
  side: true,
  network: true,
  token: true,
  currency: true,
  rails: true,
  price: true,
  priceUpdatedAt: true,
  priceTtlSeconds: true,
  minFiat: true,
  maxFiat: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.P2pOfferSelect;
export type P2pOfferRow = Prisma.P2pOfferGetPayload<{
  select: typeof P2P_OFFER_SELECT;
}>;

export function toOfferView(
  row: P2pOfferRow,
  tokenSymbol: string,
  now: Date,
): P2pMarketOfferEntity {
  return {
    id: row.id,
    accountId: row.accountId,
    side: row.side,
    network: row.network,
    token: row.token,
    tokenSymbol,
    currency: row.currency,
    rails: row.rails,
    price: row.price,
    priceUpdatedAt: row.priceUpdatedAt,
    priceTtlSeconds: row.priceTtlSeconds,
    priceFresh:
      now.getTime() - row.priceUpdatedAt.getTime() <=
      row.priceTtlSeconds * 1000,
    minFiat: row.minFiat,
    maxFiat: row.maxFiat,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every column an order view reads, sealed ones excluded. */
export const P2P_ORDER_SELECT = {
  id: true,
  consumerId: true,
  tier: true,
  kind: true,
  network: true,
  contract: true,
  token: true,
  tokenSymbol: true,
  tokenDecimals: true,
  merchantAccountId: true,
  merchantConsumerId: true,
  merchantAddress: true,
  merchantDisplayName: true,
  merchantPaymentMethodId: true,
  currency: true,
  rail: true,
  price: true,
  fiatAmount: true,
  tokenAmount: true,
  netAmount: true,
  protocolFeeBps: true,
  integratorFeeBps: true,
  integratorAddress: true,
  bond: true,
  acceptWindow: true,
  paymentWindow: true,
  settleWindow: true,
  openerAddress: true,
  sellerAddress: true,
  buyerAddress: true,
  onchainId: true,
  status: true,
  acceptDeadline: true,
  paymentDeadline: true,
  paidAt: true,
  endedAt: true,
  openTxHash: true,
  acceptTxHash: true,
  paidTxHash: true,
  releaseTxHash: true,
  cancelTxHash: true,
  disputeTxHash: true,
  resolveTxHash: true,
  settlement: true,
  paidReference: true,
  failureReason: true,
  chargeId: true,
  payoutBatchId: true,
  externalReference: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.P2pOrderSelect;
export type P2pOrderRow = Prisma.P2pOrderGetPayload<{
  select: typeof P2P_ORDER_SELECT;
}>;

export function isLive(status: string): boolean {
  return P2P_LIVE_STATUSES.includes(status as P2pOrderStatus);
}

function txHashes(row: P2pOrderRow) {
  return {
    open: row.openTxHash,
    accept: row.acceptTxHash,
    paid: row.paidTxHash,
    release: row.releaseTxHash,
    cancel: row.cancelTxHash,
    dispute: row.disputeTxHash,
    resolve: row.resolveTxHash,
  };
}

function settlementOf(value: unknown): P2pMarketOrderSettlementEntity | null {
  if (value === null || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' ? s[k] : '0');
  return {
    toBuyer: str('toBuyer'),
    toSeller: str('toSeller'),
    bondToSeller: str('bondToSeller'),
    protocolFee: str('protocolFee'),
    integratorFee: str('integratorFee'),
  };
}

/** An order as its client reads it; `paymentDetails` only when the caller is entitled to them. */
export function toOrderView(
  row: P2pOrderRow,
  chainId: number,
  paymentDetails: P2pMarketPaymentDetailsEntity | null,
): P2pMarketOrderEntity {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    tier: row.tier,
    network: row.network,
    chainId,
    contract: row.contract,
    token: row.token,
    tokenSymbol: row.tokenSymbol,
    tokenDecimals: row.tokenDecimals,
    currency: row.currency,
    rail: row.rail,
    price: row.price,
    fiatAmount: row.fiatAmount,
    tokenAmount: row.tokenAmount,
    netAmount: row.netAmount,
    protocolFeeBps: row.protocolFeeBps,
    integratorFeeBps: row.integratorFeeBps,
    bond: row.bond,
    sellerAddress: row.sellerAddress,
    buyerAddress: row.buyerAddress,
    merchant: { displayName: row.merchantDisplayName },
    onchainId: row.onchainId,
    acceptDeadline: row.acceptDeadline,
    paymentDeadline: row.paymentDeadline,
    paidAt: row.paidAt,
    endedAt: row.endedAt,
    txHashes: txHashes(row),
    settlement: settlementOf(row.settlement),
    paidReference: row.paidReference,
    failureReason: row.failureReason,
    chargeId: row.chargeId,
    payoutBatchId: row.payoutBatchId,
    externalReference: row.externalReference,
    paymentDetails,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** An order as its merchant reads it; the other party's details only while it is live. */
export function toMerchantOrderView(
  row: P2pOrderRow,
  chainId: number,
  counterparty: {
    payer: P2pMarketPayerEntity | null;
    beneficiary: P2pMarketBeneficiaryEntity | null;
  },
): P2pMarketMerchantOrderEntity {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    tier: row.tier,
    network: row.network,
    chainId,
    contract: row.contract,
    merchantAccountId: row.merchantAccountId,
    merchantSide: P2P_MERCHANT_SIDE[row.kind as P2pOrderKind],
    token: row.token,
    tokenSymbol: row.tokenSymbol,
    tokenDecimals: row.tokenDecimals,
    currency: row.currency,
    rail: row.rail,
    price: row.price,
    fiatAmount: row.fiatAmount,
    tokenAmount: row.tokenAmount,
    netAmount: row.netAmount,
    bond: row.bond,
    sellerAddress: row.sellerAddress,
    buyerAddress: row.buyerAddress,
    onchainId: row.onchainId,
    acceptDeadline: row.acceptDeadline,
    paymentDeadline: row.paymentDeadline,
    paidAt: row.paidAt,
    endedAt: row.endedAt,
    txHashes: txHashes(row),
    settlement: settlementOf(row.settlement),
    paidReference: row.paidReference,
    payer: isLive(row.status) ? counterparty.payer : null,
    beneficiary: isLive(row.status) ? counterparty.beneficiary : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A charge's order as its payer reads it. */
export function toCheckoutOrderView(
  row: P2pOrderRow,
  paymentDetails: P2pMarketPaymentDetailsEntity | null,
): P2pCheckoutOrderEntity {
  return {
    id: row.id,
    chargeId: row.chargeId ?? '',
    status: row.status,
    currency: row.currency,
    fiatAmount: row.fiatAmount,
    rail: row.rail,
    merchantName: row.merchantDisplayName,
    paymentDeadline: row.paymentDeadline,
    paymentDetails: isLive(row.status) ? paymentDetails : null,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

/**
 * The keys an order's webhook carries to its CLIENT (the consumer that created
 * it): its own order as `GET /v1/p2p/orders/{id}` answers it, minus
 * `paymentDetails` (the merchant's account: personal data, read on the route).
 */
export const P2P_CLIENT_WEBHOOK_KEYS = [
  'id',
  'kind',
  'status',
  'tier',
  'network',
  'chainId',
  'contract',
  'token',
  'tokenSymbol',
  'tokenDecimals',
  'currency',
  'rail',
  'price',
  'fiatAmount',
  'tokenAmount',
  'netAmount',
  'protocolFeeBps',
  'integratorFeeBps',
  'bond',
  'sellerAddress',
  'buyerAddress',
  'merchant',
  'onchainId',
  'acceptDeadline',
  'paymentDeadline',
  'paidAt',
  'endedAt',
  'txHashes',
  'settlement',
  'paidReference',
  'failureReason',
  'chargeId',
  'payoutBatchId',
  'externalReference',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof P2pMarketOrderEntity)[];

/**
 * The keys an order's webhook carries to its MERCHANT: the merchant order
 * projection (`GET /v1/p2p/merchant/orders/{id}`), minus `payer` and
 * `beneficiary`. Nothing the client keeps for itself (`externalReference`,
 * `chargeId`, `payoutBatchId`, its integrator fee) ever reaches the merchant.
 */
export const P2P_MERCHANT_WEBHOOK_KEYS = [
  'id',
  'kind',
  'status',
  'tier',
  'network',
  'chainId',
  'contract',
  'merchantAccountId',
  'merchantSide',
  'token',
  'tokenSymbol',
  'tokenDecimals',
  'currency',
  'rail',
  'price',
  'fiatAmount',
  'tokenAmount',
  'netAmount',
  'bond',
  'sellerAddress',
  'buyerAddress',
  'onchainId',
  'acceptDeadline',
  'paymentDeadline',
  'paidAt',
  'endedAt',
  'txHashes',
  'settlement',
  'paidReference',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof P2pMarketMerchantOrderEntity)[];

function pickKeys<T extends object>(
  view: T,
  keys: readonly (keyof T)[],
): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, view[k]]));
}

/**
 * The body of an order's webhook for one role: an explicit allowlist of that
 * role's own projection, plus the role. Never a payment method, a payer's
 * identity or a beneficiary's account for either role: delivery bodies are
 * stored in plain text (`webhook_delivery`), which would undo the seal at
 * rest; the routes are where an entitled party reads them.
 */
export function toOrderWebhookData(
  row: P2pOrderRow,
  chainId: number,
  role: 'client' | 'merchant',
): Record<string, unknown> {
  const body =
    role === 'client'
      ? pickKeys(toOrderView(row, chainId, null), P2P_CLIENT_WEBHOOK_KEYS)
      : pickKeys(
          toMerchantOrderView(row, chainId, { payer: null, beneficiary: null }),
          P2P_MERCHANT_WEBHOOK_KEYS,
        );
  return { ...body, role };
}

export const P2P_CHARGE_SELECT = {
  id: true,
  tier: true,
  network: true,
  token: true,
  currency: true,
  fiatAmount: true,
  recipientAccountId: true,
  recipientAddress: true,
  description: true,
  multiUse: true,
  status: true,
  paidCount: true,
  paidAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.P2pChargeSelect;
export type P2pChargeRow = Prisma.P2pChargeGetPayload<{
  select: typeof P2P_CHARGE_SELECT;
}>;

/** `open` past `expiresAt` reads `expired`; nothing stores it. */
export function chargeStatus(row: P2pChargeRow, now: Date): string {
  return row.status === 'open' && row.expiresAt <= now ? 'expired' : row.status;
}

export function toChargeView(
  row: P2pChargeRow,
  tokenSymbol: string,
  checkoutUrl: string,
  now: Date,
): P2pMarketChargeEntity {
  return {
    id: row.id,
    tier: row.tier,
    network: row.network,
    token: row.token,
    tokenSymbol,
    currency: row.currency,
    fiatAmount: row.fiatAmount,
    recipientAccountId: row.recipientAccountId,
    recipientAddress: row.recipientAddress,
    description: row.description,
    multiUse: row.multiUse,
    status: chargeStatus(row, now),
    paidCount: row.paidCount,
    paidAt: row.paidAt,
    expiresAt: row.expiresAt,
    url: `${checkoutUrl}/${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
