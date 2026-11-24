import { createHmac, hkdfSync } from 'node:crypto';
import type {
  PaymentDeposit,
  PaymentIntent,
  Prisma,
} from '@generated/prisma/client';
import { formatUnits, parseUnits } from '@/chains/units';
import { rateLimitSubject } from '@/common/client-ip';
import { readMerchantFeeRecord } from '@/common/merchant-fee/merchant-fee';
import type { CrossChainNetworkId } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import type { NearIntentsTransaction } from '@/near-intents/near-intents.types';
import type {
  PaidFromEntity,
  PaymentDepositEntity,
} from '@/payment-intents/entities/payment-deposit.entity';
import {
  PAYMENT_DEPOSIT_CLIENT_IPV6_HEXTETS,
  PAYMENT_DEPOSIT_LINK_BUDGET,
  PAYMENT_DEPOSIT_LINK_WINDOW_MS,
  PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
  PAYMENT_DEPOSIT_CLIENT_KEY_LABEL,
  PAYMENT_DEPOSIT_CLIENT_KEY_SALT,
} from '@/payment-intents/payment-intents.constants';
import {
  isDepositNetwork,
  isPaymentNetwork,
} from '@/payment-intents/payment-networks';
import { isChain } from '@/chains/chains.constants';
import { decimalPlaces } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';

/** The intent columns that decide whether it can be paid from another network. */
export type CrossChainPayableFields = Pick<
  PaymentIntent,
  'kind' | 'chain' | 'network' | 'amount' | 'merchantFee' | 'crossChainFeeBps'
>;

/**
 * Why `intent` cannot be paid from another network, or null when it can. A
 * payment from another network is an exact-output quote at the cross-chain
 * route that pays the intent's destination, so it needs:
 *
 *   - a payment link (`PAY`): a `TX` intent is a Stellar envelope one known
 *     payer signs;
 *   - mainnet, or, on a test network, a link on a network paid through
 *     deposit addresses, which the sandbox settles (the route has no test
 *     network; `SandboxDepositRoute`);
 *   - on Stellar, Solana and Monad, no merchant fee: there the fee goes to a
 *     wallet on the chain, which the route cannot pay beside the merchant (on
 *     the other networks the fee is the route's own app fee, made for that);
 *   - a commission rate recorded at creation (`crossChainFeeBps`): a deposit is
 *     created keyless, with no plan header to read the rate from.
 *
 * A link without an amount qualifies: the payer types the amount, and the quote
 * pays exactly that. Every link on a network other than Stellar, Solana and
 * Monad meets them by construction. A refusal names the reason in words a payer
 * can act on, never the stored values.
 */
export function crossChainPaymentRefusal(
  intent: CrossChainPayableFields,
): string | null {
  if (!isPaymentNetwork(intent.chain)) return 'it is on an unknown network';
  if (intent.kind !== 'PAY') return 'it is a transaction for one known payer';
  // On a test network only the networks paid through deposit addresses take
  // payments from another network: the sandbox settles those itself (and says
  // which of them it reaches when a payer asks).
  if (intent.network !== 'public' && !isDepositNetwork(intent.chain)) {
    return 'it is on a test network, where only links on networks paid through deposit addresses take payments from another network';
  }
  if (
    isChain(intent.chain) &&
    readMerchantFeeRecord(intent.merchantFee) !== null
  ) {
    return 'it carries a merchant fee';
  }
  if (typeof intent.crossChainFeeBps !== 'number') {
    return 'it was created without payments from other networks';
  }
  return null;
}

/** Whether the payer may pay `intent` from another network. */
export function acceptsCrossChainPayment(
  intent: CrossChainPayableFields,
): boolean {
  return crossChainPaymentRefusal(intent) === null;
}

/**
 * How the intent's own asset is asked of the cross-chain route's list
 * (`resolveCrossChainAsset`): the native coin, Stellar's `CODE:ISSUER`, or the
 * token's contract (SPL mint, ERC-20, the route's contract on the other
 * networks). Never a bare symbol: two tokens may share one, and the merchant
 * named a contract.
 */
export function linkAssetRequest(
  intent: Pick<PaymentIntent, 'chain' | 'asset' | 'assetIssuer'>,
): string {
  if (!intent.assetIssuer) return 'native';
  return intent.chain === 'stellar'
    ? `${intent.asset}:${intent.assetIssuer}`
    : intent.assetIssuer;
}

/** A transaction list as stored (JSON), read back; null when absent or malformed. */
export function readTransactions(
  value: Prisma.JsonValue | null,
): NearIntentsTransaction[] | null {
  if (!Array.isArray(value)) return null;
  const txs = value.filter(
    (tx): tx is { hash: string; explorerUrl: string } =>
      typeof tx === 'object' &&
      tx !== null &&
      !Array.isArray(tx) &&
      typeof (tx as Record<string, unknown>).hash === 'string' &&
      typeof (tx as Record<string, unknown>).explorerUrl === 'string',
  );
  return txs.map(({ hash, explorerUrl }) => ({ hash, explorerUrl }));
}

/**
 * What a payer and the link's owner may see of a deposit, field by field: the
 * row also holds the route's signed quote, its correlation id and the
 * observer's bookkeeping, none of which leaves.
 */
export function toPaymentDepositEntity(
  row: PaymentDeposit,
  qr: string,
): PaymentDepositEntity {
  return {
    id: row.id,
    paymentLinkId: row.intentId ?? '',
    status: row.status,
    originChain: row.originChain as CrossChainNetworkId,
    originAsset: row.originAsset,
    originContract: row.originContract,
    amountIn: row.amountIn,
    minAmountIn: row.minAmountIn,
    destinationChain: row.destinationChain as CrossChainNetworkId,
    destinationAsset: row.destinationAsset,
    destinationContract: row.destinationContract,
    amountOut: row.amountOut,
    feeBps: row.feeBps,
    feeAmount: row.feeAmount,
    merchantFee: readMerchantFeeRecord(row.merchantFee),
    refundTo: row.refundTo,
    depositAddress: row.depositAddress,
    depositMemo: row.depositMemo,
    depositUri: row.depositUri,
    qr,
    amountOutPaid: row.amountOutPaid,
    refundedAmount: row.refundedAmount,
    originTxHashes: readTransactions(row.originTxHashes),
    destinationTxHashes: readTransactions(row.destinationTxHashes),
    timeEstimateSeconds: row.timeEstimateSeconds,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The `paidFrom` an intent records when `deposit` settles it. */
export function paidFromRecord(deposit: PaymentDeposit): PaidFromEntity {
  return {
    depositId: deposit.id,
    chain: deposit.originChain as CrossChainNetworkId,
    asset: deposit.originAsset,
    contract: deposit.originContract,
    amount: deposit.amountIn,
  };
}

/** A stored `paidFrom`, read back; null when absent or not one. */
export function readPaidFrom(
  value: Prisma.JsonValue | null | undefined,
): PaidFromEntity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.depositId !== 'string' ||
    typeof v.chain !== 'string' ||
    typeof v.asset !== 'string' ||
    typeof v.amount !== 'string' ||
    (v.contract !== null && typeof v.contract !== 'string')
  ) {
    return null;
  }
  return {
    depositId: v.depositId,
    chain: v.chain as CrossChainNetworkId,
    asset: v.asset,
    contract: v.contract ?? null,
    amount: v.amount,
  };
}

/**
 * Why a deposit the route reports SUCCEEDED does not settle its intent, or
 * null when it does: the route must report the payout transaction on the
 * intent's network (it becomes the intent's `txHash`) and a paid amount of at
 * least what the intent asks, in the intent's asset. The quote fixed both, so
 * a shortfall is the route breaking its own quote; the intent then stays open
 * and the operator reads the warning.
 */
export function settlementRefusal(
  deposit: Pick<
    PaymentDeposit,
    'amountOut' | 'destinationDecimals' | 'amountOutPaid'
  >,
  destinationTxHashes: NearIntentsTransaction[] | null,
): string | null {
  if (!destinationTxHashes?.length) {
    return 'no payout transaction was reported';
  }
  if (deposit.amountOutPaid === null) return 'no paid amount was reported';
  try {
    const paid = parseUnits(deposit.amountOutPaid, deposit.destinationDecimals);
    const owed = parseUnits(deposit.amountOut, deposit.destinationDecimals);
    if (paid < owed) {
      return `the payout (${deposit.amountOutPaid}) is below the link's amount (${deposit.amountOut})`;
    }
  } catch {
    return `the paid amount "${deposit.amountOutPaid}" cannot be read`;
  }
  return null;
}

/**
 * The key client addresses are MACed under: HKDF-SHA256 of the server secret,
 * labelled for this one use, so it is never the secret itself nor a key derived
 * for anything else.
 */
export function paymentDepositClientSecret(secret: string): Buffer {
  if (!secret) throw new Error('payment deposits need a non-empty secret');
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      PAYMENT_DEPOSIT_CLIENT_KEY_SALT,
      PAYMENT_DEPOSIT_CLIENT_KEY_LABEL,
      32,
    ),
  );
}

/**
 * The client a deposit counts against: an IPv4 address as it is, an IPv6
 * address by its /48 (`PAYMENT_DEPOSIT_CLIENT_IPV6_HEXTETS`), built on the rate
 * limits' own normalisation (`rateLimitSubject`: IPv4-mapped addresses, zone
 * ids, `::` elision). `ip` is `clientIp(req)`, the peer as the trusted proxy saw
 * it.
 */
export function paymentDepositClientSubject(ip: string): string {
  const subject = rateLimitSubject(ip);
  const v6 = /^([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3})::\/64$/.exec(subject);
  if (!v6) return subject;
  // One spelling per prefix: `0db8` and `db8` are the same hextet.
  const hextets = v6[1]
    .split(':')
    .slice(0, PAYMENT_DEPOSIT_CLIENT_IPV6_HEXTETS)
    .map((h) => parseInt(h, 16).toString(16));
  return `${hextets.join(':')}::/${PAYMENT_DEPOSIT_CLIENT_IPV6_HEXTETS * 16}`;
}

/**
 * What a client is stored as on a deposit: `base64url(HMAC-SHA256(key,
 * subject))`, where `subject` is {@link paymentDepositClientSubject}. Equal for
 * one client, so the per-client cap can count it; the address itself is never
 * stored.
 */
export function paymentDepositClientKey(key: Buffer, subject: string): string {
  return createHmac('sha256', key).update(subject).digest('base64url');
}

/** A link's limits on payments from another network, as they apply now. */
export interface DepositLimits {
  /** Open deposit addresses one payer (client) may have on the link. */
  perPayer: number;
  /** New deposit addresses the link takes per `windowSeconds`. */
  perWindow: number;
  windowSeconds: number;
}

/** The merchant's own limits for the link, or the defaults where it set none. */
export function depositLimitsOf(
  intent: Pick<PaymentIntent, 'depositMaxPerPayer' | 'depositBudgetPerWindow'>,
): DepositLimits {
  return {
    perPayer: intent.depositMaxPerPayer ?? PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
    perWindow: intent.depositBudgetPerWindow ?? PAYMENT_DEPOSIT_LINK_BUDGET,
    windowSeconds: PAYMENT_DEPOSIT_LINK_WINDOW_MS / 1000,
  };
}

/**
 * The amount a payment from another network is for, in the link's asset: the
 * link's own when it has one (another one is refused), the payer's when it has
 * none (then required, above zero, within the asset's decimals). Returned in
 * one spelling (`formatUnits` of the parsed value), so two requests for the
 * same amount compare equal.
 */
export function requestedAmountOut(
  intent: Pick<PaymentIntent, 'chain' | 'amount' | 'assetDecimals'>,
  requested: string | undefined,
): string {
  const decimals =
    intent.assetDecimals ??
    (intent.chain === 'stellar' ? STELLAR_DECIMALS : MAX_AMOUNT_DECIMALS);
  if (intent.amount !== null) {
    if (
      requested !== undefined &&
      !sameDecimal(requested, intent.amount, decimals)
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This payment link has a fixed amount: send no amount, or exactly its own.',
      );
    }
    return intent.amount;
  }
  if (requested === undefined) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'amount is required: this payment link has no fixed amount, so the payer says how much to pay.',
    );
  }
  if (decimalPlaces(requested) > decimals) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      `amount has more decimal places than this payment link's asset allows (${decimals})`,
    );
  }
  const units = parseUnits(requested, decimals);
  if (units <= 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      'amount must be greater than zero',
    );
  }
  return formatUnits(units, decimals);
}

/** The most decimals an amount on a link with no stored decimals is read with. */
const MAX_AMOUNT_DECIMALS = 18;

function sameDecimal(a: string, b: string, decimals: number): boolean {
  try {
    return parseUnits(a, decimals) === parseUnits(b, decimals);
  } catch {
    return false;
  }
}
