import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  assertMerchantFeeCovered,
  type MerchantFeeRecord,
  type MerchantFeeTerms,
  merchantFeeRecord,
  readMerchantFeeRecord,
  resolveMerchantFee,
  sameMerchantFee,
  splitMerchantFee,
} from '@/common/merchant-fee/merchant-fee';
import {
  commissionWithRecipient,
  resolvePlanCommissionBps,
} from '@/common/plan-commission';
import {
  isUniqueViolation,
  uniqueViolationColumns,
  uniqueViolationNames,
} from '@/common/prisma-errors';
import { resolveNetwork } from '@/common/stellar-network';
import { PrismaService } from '@/prisma/prisma.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { CustomersService } from '@/customers/customers.service';
import { assetLabel, resolveAsset, type ResolvedAsset } from '@/stellar/asset';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import { decimalPlaces, parseUnits } from '@/chains/units';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import type {
  PaidFromEntity,
  PaymentPayerEmailListEntity,
} from '@/payment-intents/entities/payment-deposit.entity';
import { PaymentDepositPricing } from '@/payment-intents/payment-deposit-pricing.service';
import {
  type DepositLimits,
  depositLimitsOf,
  readPaidFrom,
} from '@/payment-intents/payment-deposit-rules';
import type { DepositLimitsDto } from '@/payment-intents/dto/deposit-limits.dto';
import {
  type DepositNetwork,
  isDepositNetwork,
  type PaymentNetwork,
  isRoutedNetwork,
  paymentAddressRule,
  paymentNetworkOf,
} from '@/payment-intents/payment-networks';
import { resolveOrMintMemoId } from '@/stellar/memo';
import type {
  PaymentIntent,
  PaymentIntentStatus,
  PaymentIntentTransition,
  Prisma,
  WebhookEventType,
} from '@generated/prisma/client';
import { project } from '@/common/projection';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { CreateTxPaymentIntentDto } from '@/payment-intents/dto/create-tx-payment-intent.dto';
import { CreatePayPaymentIntentDto } from '@/payment-intents/dto/create-pay-payment-intent.dto';
import { QueryPaymentIntentsDto } from '@/payment-intents/dto/query-payment-intents.dto';
import { UpdatePaymentIntentDto } from '@/payment-intents/dto/update-payment-intent.dto';
import {
  assertTransition,
  canTransition,
  InvalidPaymentIntentTransitionError,
  isTerminalStatus,
} from '@/payment-intents/payment-intent-state-machine';
import {
  isSameIntentRequest,
  type PaymentIntentTerms,
} from '@/payment-intents/payment-intent-replay';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { isEvmChain } from '@/evm/evm.constants';
import { ChainPayLinkBuilder } from '@/payment-intents/chain-pay-link-builder.service';
import { PaymentVerifiers } from '@/payment-intents/payment-verifiers';
import {
  type CheckoutTheme,
  effectiveCheckoutTheme,
  PAYMENT_PAYER_EMAILS_LISTED,
} from '@/payment-intents/payment-intents.constants';
import { settlementRivalsQuery } from '@/payment-intents/settlement-rivals';
import { SANDBOX_MERCHANT_FEE_REFUSAL } from '@/sandbox-settlement/sandbox-settlement.constants';
import {
  expectedTxId,
  isTxIdFor,
  normalizeTxId,
} from '@/payment-intents/tx-id';
import {
  DEFAULT_CHAIN,
  isChain,
  NATIVE_DECIMALS,
  type OtherChain,
} from '@/chains/chains.constants';

/** Who triggered a status change — stored on the audit row. */
export type PaymentIntentTransitionActor =
  'api' | 'validate' | 'observer' | 'system';

export interface TransitionOptions {
  consumerUsername: string;
  actor: PaymentIntentTransitionActor;
  reason?: string;
  txHash?: string;
  /** On-chain payer for PAY intents settled by observer/validate. */
  payer?: string;
  /** When the settling transaction closed on-chain, when the verifier read it. */
  paidAt?: Date;
  /**
   * The intent's chain verifier confirmed that `txHash` pays this intent. Only
   * {@link PaymentIntentsService.markSucceeded} sets it, and settling an
   * EXPIRED intent requires it (`VERIFIED_SETTLEMENT_ONLY_FROM`).
   */
  verifiedOnChain?: boolean;
  /**
   * What the payer sent, when a payment from another network settles the
   * intent (`settleFromDeposit`): written with the status, so the
   * PAYMENT_INTENT_SUCCEEDED webhook carries it.
   */
  paidFrom?: PaidFromEntity;
}

export interface ValidationOutcome {
  valid: boolean;
  status: PaymentIntentStatus;
  reason?: string;
  paymentIntent?: PaymentIntentView;
}

/**
 * The columns an intent may leave this service with: every field
 * `PaymentIntentEntity` documents, plus `expiresAt`. An allowlist, because the
 * spread it replaces answered with the whole row — `consumerId` and the
 * observer's `horizonCursor` — including on the create routes the shared public
 * key reaches, where an identical replay returns the stored intent. The list
 * reads through it as a `select`; single-intent paths cut the row with
 * {@link project}.
 */
export const PAYMENT_INTENT_PUBLIC_SELECT = {
  id: true,
  kind: true,
  status: true,
  chain: true,
  network: true,
  source: true,
  destination: true,
  amount: true,
  asset: true,
  assetIssuer: true,
  memo: true,
  chainReference: true,
  networkFee: true,
  msg: true,
  callback: true,
  xdr: true,
  uri: true,
  txHash: true,
  reference: true,
  checkoutTheme: true,
  merchantFee: true,
  paidFrom: true,
  depositMaxPerPayer: true,
  depositBudgetPerWindow: true,
  receiptTo: true,
  receiptSentAt: true,
  receiptSkippedAt: true,
  expiresAt: true,
  checkoutSeenAt: true,
  checkoutWalletAt: true,
  checkoutWalletClosedAt: true,
  checkoutSentAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PaymentIntentSelect;

/** An intent's columns as {@link PAYMENT_INTENT_PUBLIC_SELECT} reads them. */
type PublicPaymentIntentRow = Prisma.PaymentIntentGetPayload<{
  select: typeof PAYMENT_INTENT_PUBLIC_SELECT;
}>;

/**
 * An intent as the list returns it: the public columns, with `checkoutTheme`
 * read as the design the page shows rather than the null stored for "none",
 * and `merchantFee` as the stored record read back (null without one).
 */
export type PublicPaymentIntent = Omit<
  PublicPaymentIntentRow,
  | 'checkoutTheme'
  | 'merchantFee'
  | 'paidFrom'
  | 'depositMaxPerPayer'
  | 'depositBudgetPerWindow'
> & {
  checkoutTheme: CheckoutTheme;
  merchantFee: MerchantFeeRecord | null;
  paidFrom: PaidFromEntity | null;
  depositLimits: DepositLimits;
};

/** A Stellar intent's merchant fee: the request's terms and the legs they split `amount` into. */
interface StellarMerchantFee {
  terms: MerchantFeeTerms;
  record: MerchantFeeRecord;
  /** What `destination` receives. */
  destinationAmount: string;
}

/** A public intent plus its derived QR code — what single-intent responses return. */
export type PaymentIntentView = PublicPaymentIntent & { qr: string };

/**
 * A payment intent's lifecycle: the idempotent create, reads, the guarded
 * status transitions with their audit trail and webhooks, and chain-verified
 * settlement.
 *
 * What an intent looks like on the wire — URI, envelope, QR — is
 * {@link Sep7LinkBuilder}'s, and the customer a settled payment adds is
 * {@link CustomersService}'s. Both used to be written here, the second straight
 * into the customers module's table.
 */
@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly verifiers: PaymentVerifiers,
    private readonly links: Sep7LinkBuilder,
    private readonly consumers: ConsumerResolverService,
    private readonly customers: CustomersService,
    private readonly chainLinks: ChainPayLinkBuilder,
    private readonly depositPricing: PaymentDepositPricing,
  ) {}

  /**
   * The Stellar network is dictated by the caller's API key type, forwarded by
   * the gateway: `prod` key → public, `dev` key → testnet. Falls back to the
   * configured default only when the gateway didn't forward an environment
   * (local dev without APISIX).
   */
  private resolveNetwork(consumer: GatewayConsumer): StellarNetwork {
    return resolveNetwork(this.config, consumer);
  }

  /**
   * The one filter every by-id read and write of an intent goes through: the
   * calling consumer AND the network its key targets. A sandbox key used to read,
   * patch, validate and delete its own account's mainnet intents (and a production
   * key its test-network ones), because these lookups filtered by consumer only
   * while the list filtered by both. Another network's intent is the 404 of a
   * missing one, as another consumer's is.
   */
  private ownedWhere(consumer: GatewayConsumer, id: string) {
    return {
      id,
      consumer: { apisixUsername: consumer.username },
      network: this.resolveNetwork(consumer),
    };
  }

  /**
   * Emits a domain event the webhook dispatcher fans out to integrators.
   *
   * Everything goes through {@link WebhookTerminalEmitter} rather than straight
   * onto the in-memory bus. For PAYMENT_INTENT_SUCCEEDED / _FAILED that is what
   * makes the notification durable: the emitter writes the `webhook_delivery`
   * rows inside its own transaction *before* the bus sees the event, so a pod
   * killed mid-notification leaves work the delivery sweeper can finish. Without
   * it, a crash between the settled status and the bus listener lost the
   * settlement notification permanently, with nothing to retry from.
   *
   * Non-terminal events (CREATED / UPDATED / CANCELLED / DELETED) short-circuit
   * inside `emit` straight to the bus, so routing them here costs nothing and
   * keeps one emission path for the module.
   *
   * @returns `false` when a prior claim already notified — impossible for an
   * intent today (see the transition graph: SUCCEEDED and FAILED are absorbing,
   * and the status change is a compare-and-swap only one writer wins), so
   * callers do not branch on it.
   */
  private emit(
    consumerUsername: string,
    type: WebhookEventType,
    data: PaymentIntent,
  ): Promise<boolean> {
    return this.webhooks.emit(consumerUsername, type, data);
  }

  /** Maps a status change to the matching webhook event type. */
  private statusEvent(status: PaymentIntentStatus): WebhookEventType {
    switch (status) {
      case 'SUCCEEDED':
        return 'PAYMENT_INTENT_SUCCEEDED';
      case 'FAILED':
        return 'PAYMENT_INTENT_FAILED';
      case 'CANCELLED':
        return 'PAYMENT_INTENT_CANCELLED';
      default:
        return 'PAYMENT_INTENT_UPDATED';
    }
  }

  /**
   * Ensures a local Consumer row mirrors the APISIX consumer that authenticated
   * the request. Every payment intent is scoped to this record.
   */
  private resolveConsumer(consumer: GatewayConsumer) {
    return this.consumers.resolve(consumer);
  }

  /** QR is derived from the stored SEP-7 URI rather than persisted. */
  private async withQr(intent: PaymentIntent): Promise<PaymentIntentView> {
    return {
      ...toPublicPaymentIntent(project(intent, PAYMENT_INTENT_PUBLIC_SELECT)),
      qr: await this.links.qr(intent.uri),
    };
  }

  /** Idempotency: return the existing intent for (consumer, memo), if any. */
  private async findByMemo(
    consumerId: string,
    memo: string,
  ): Promise<PaymentIntent | null> {
    return this.prisma.paymentIntent.findUnique({
      where: { consumerId_memo: { consumerId, memo } },
    });
  }

  /**
   * Resolves a create that landed on an existing `(consumer, memo)`: the stored
   * intent when the request describes the same payment, a 409 when it does not.
   * {@link isSameIntentRequest} explains why a matching memo is not enough.
   *
   * `stored` is null only on the race path, when the row that beat this
   * request's insert was deleted again before it could be read back.
   */
  private replayOf(
    stored: PaymentIntent | null,
    terms: PaymentIntentTerms,
    merchant: MerchantFeeTerms | null = null,
  ): Promise<PaymentIntentView> {
    if (!stored) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'A concurrent request for this memo changed it while this one was ' +
          'being created. Retry the request.',
      );
    }
    // The merchant fee is compared like the destination: it pays a wallet the
    // caller names. Decimals are the intent's own (Stellar's when it has none).
    if (
      !isSameIntentRequest(stored, terms) ||
      !sameMerchantFee(
        stored.merchantFee,
        merchant,
        stored.assetDecimals ?? STELLAR_DECIMALS,
      )
    ) {
      // Names nothing about the stored intent. Under the shared public key it
      // may be another caller's, and saying which term differed would let a
      // caller recover that intent one field at a time.
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A payment intent with this memo already exists for different payment ' +
          'details. Retry with the original request unchanged, or use a new ' +
          'memo (omit it to have one generated).',
      );
    }
    return this.withQr(stored);
  }

  // ── CREATE: tx ──────────────────────────────────────────────────────────────
  /**
   * SEP-7 `tx`: build the unsigned TransactionEnvelope from a known `source` and
   * return its XDR + `web+stellar:tx?xdr=...` URI + QR for the wallet to sign.
   * Network is dictated by the caller's API key type.
   */
  async createTx(
    consumer: GatewayConsumer,
    dto: CreateTxPaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const network = this.resolveNetwork(consumer);
    const localConsumer = await this.resolveConsumer(consumer);
    const asset = resolveAsset(dto.assetCode, dto.assetIssuer);
    // Mandatory, unlike a swap's: the MEMO_ID is what ties the on-chain payment
    // back to this intent, and half of the create's idempotency key.
    const memo = resolveOrMintMemoId(dto.memo);
    const terms: PaymentIntentTerms = {
      kind: 'TX',
      chain: 'stellar',
      network,
      source: dto.source,
      destination: dto.destination,
      amount: dto.amount,
      asset: asset.code,
      assetIssuer: asset.issuer,
      msg: dto.msg ?? null,
      callback: dto.callback ?? null,
    };
    const merchant = this.stellarMerchantFee(dto, asset, dto.amount, [
      dto.destination,
      dto.source,
    ]);

    // Idempotency: a retry on the same (consumer, memo) returns the original
    // intent before any Horizon round trip — but only for the same payment.
    const existing = await this.findByMemo(localConsumer.id, memo);
    if (existing) return this.replayOf(existing, terms, merchant?.terms);

    if (merchant) {
      await this.links.assertWalletCanReceive(
        network,
        asset,
        merchant.terms.wallet,
      );
    }
    const { xdr, uri } = await this.links.tx(network, {
      source: dto.source,
      destination: dto.destination,
      amount: merchant?.destinationAmount ?? dto.amount,
      asset,
      memo,
      msg: dto.msg,
      callback: dto.callback,
      fee: merchant
        ? { wallet: merchant.terms.wallet, amount: merchant.record.amount }
        : null,
    });

    const intent = await this.persist({
      ...terms,
      consumerId: localConsumer.id,
      memo,
      status: 'PENDING',
      xdr,
      uri,
      // Beside the terms, not among them: a retry is not compared on the
      // design (see `isSameIntentRequest`).
      checkoutTheme: dto.checkoutTheme ?? null,
      ...merchantFeeColumn(merchant?.record),
    });
    if (!intent) {
      return this.replayOf(
        await this.findByMemo(localConsumer.id, memo),
        terms,
        merchant?.terms,
      );
    }

    this.logger.log(
      `Created TX payment intent ${intent.id}: ${dto.amount} ` +
        `${assetLabel(asset)} ${dto.source} → ${dto.destination} ` +
        `(consumer=${consumer.username}, network=${network}, memo=${memo})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_CREATED', intent);
    return this.withQr(intent);
  }

  // ── CREATE: pay ─────────────────────────────────────────────────────────────
  /**
   * SEP-7 `pay`: no source/XDR — return a `web+stellar:pay?destination=...` URI
   * carrying the destination and any optional payment fields, plus a QR.
   */
  async createPay(
    consumer: GatewayConsumer,
    dto: CreatePayPaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const chain = dto.chain ?? DEFAULT_CHAIN;
    if (isDepositNetwork(chain)) {
      return this.createPayThroughDeposits(consumer, chain, dto);
    }
    if (chain !== 'stellar') {
      return this.createPayOnChain(consumer, chain, dto);
    }
    const network = this.resolveNetwork(consumer);
    const localConsumer = await this.resolveConsumer(consumer);
    const asset = resolveAsset(dto.assetCode, dto.assetIssuer);
    const memo = resolveOrMintMemoId(dto.memo);
    const terms: PaymentIntentTerms = {
      kind: 'PAY',
      chain: 'stellar',
      network,
      source: null,
      destination: dto.destination,
      amount: dto.amount ?? null,
      asset: asset.code,
      assetIssuer: asset.issuer,
      msg: dto.msg ?? null,
      callback: dto.callback ?? null,
    };
    if (dto.merchantFee && dto.amount === undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'A merchant fee needs an amount: an open-amount link has nothing to take it from',
      );
    }
    const merchant =
      dto.amount === undefined
        ? null
        : this.stellarMerchantFee(dto, asset, dto.amount, [dto.destination]);

    const existing = await this.findByMemo(localConsumer.id, memo);
    if (existing) return this.replayOf(existing, terms, merchant?.terms);

    if (merchant) {
      await this.links.assertWalletCanReceive(
        network,
        asset,
        merchant.terms.wallet,
      );
    }
    // A SEP-7 `pay` link pays one account, so a link with a merchant fee has no
    // link of its own: its `uri` becomes the hosted checkout once the id
    // exists, and the page builds the payer's envelope with both payments
    // (`POST /v1/payment-links/{id}/transaction`).
    const uri = merchant
      ? ''
      : this.links.pay({
          destination: dto.destination,
          amount: dto.amount,
          asset,
          memo,
          msg: dto.msg,
          callback: dto.callback,
        });

    let intent = await this.persist({
      ...terms,
      consumerId: localConsumer.id,
      memo,
      status: 'PENDING',
      xdr: null,
      uri,
      checkoutTheme: dto.checkoutTheme ?? null,
      ...merchantFeeColumn(merchant?.record),
      crossChainFeeBps: this.optionalCrossChainFeeBps(consumer, {
        network,
        amount: dto.amount,
        merchantFee: !!merchant,
        recognisedByAmount: false,
        routed: true,
      }),
      ...depositLimitColumns(dto.depositLimits),
    });
    if (!intent) {
      return this.replayOf(
        await this.findByMemo(localConsumer.id, memo),
        terms,
        merchant?.terms,
      );
    }
    if (merchant) {
      intent = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { uri: this.checkoutLink(intent.id) },
      });
    }

    this.logger.log(
      `Created PAY payment intent ${intent.id}: ${dto.amount ?? '(open)'} ` +
        `${assetLabel(asset)} → ${dto.destination} ` +
        `(consumer=${consumer.username}, network=${network}, memo=${memo})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_CREATED', intent);
    return this.withQr(intent);
  }

  /**
   * A PAY intent on Solana, Monad or Arc: a Solana Pay transfer request or an
   * EIP-681 link, built by {@link ChainPayLinkBuilder}. The memo is still the
   * idempotency key, and a retry is still held to the same payment
   * ({@link replayOf}) — compared in the chain's stored spelling, so an EVM
   * address sent in another case is the same destination.
   */
  private async createPayOnChain(
    consumer: GatewayConsumer,
    chain: OtherChain,
    dto: CreatePayPaymentIntentDto,
  ): Promise<PaymentIntentView> {
    if (dto.callback !== undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `callback is a SEP-7 field and is not supported on ${chain}.`,
      );
    }
    if (dto.merchantFee && dto.amount === undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'A merchant fee needs an amount: an open-amount link has nothing to take it from',
      );
    }
    if (
      chain === 'solana' &&
      dto.merchantFee &&
      !this.config.get('paymentIntents', { infer: true }).apiUrl
    ) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'A Solana payment link with a merchant fee is a Solana Pay transaction request, ' +
          'which names the gateway: PAYMENT_LINK_API_URL is not set.',
      );
    }
    const network = this.resolveNetwork(consumer);
    const localConsumer = await this.resolveConsumer(consumer);
    const memo = resolveOrMintMemoId(dto.memo);
    const normalized = this.chainLinks.normalize(chain, network, dto);
    const terms: PaymentIntentTerms = {
      kind: 'PAY',
      chain,
      network,
      source: null,
      destination: normalized.destination,
      amount: dto.amount ?? null,
      asset: normalized.asset,
      assetIssuer: normalized.assetIssuer,
      msg: dto.msg ?? null,
      callback: null,
    };

    const existing = await this.findByMemo(localConsumer.id, memo);
    if (existing) {
      // The fee's fixed part is read in the stored asset's decimals.
      return this.replayOf(
        existing,
        terms,
        resolveMerchantFee(
          dto.merchantFee,
          existing.assetDecimals ?? NATIVE_DECIMALS[chain],
          CHAIN_ADDRESS_RULES[chain],
        ),
      );
    }

    const link = await this.chainLinks.build(chain, {
      network,
      destination: dto.destination,
      amount: dto.amount,
      assetCode: dto.assetCode,
      assetIssuer: dto.assetIssuer,
      memo,
      msg: dto.msg,
      merchantFee: dto.merchantFee,
    });

    // A Solana link with a merchant fee is a Solana Pay transaction request:
    // the wallet asks the gateway for the transaction with both transfers
    // (`/v1/payment-links/{id}/solana-pay`), so its link names the intent id.
    // On Monad and Arc the deposit address pays the fee (PaymentSplitForwarder).
    const merchant = link.merchantFee ?? null;
    const transactionRequest = chain === 'solana' && merchant !== null;
    let intent = await this.persist({
      ...terms,
      consumerId: localConsumer.id,
      memo,
      status: 'PENDING',
      xdr: null,
      uri: transactionRequest ? '' : link.uri,
      checkoutTheme: dto.checkoutTheme ?? null,
      ...merchantFeeColumn(merchant?.record),
      crossChainFeeBps: this.optionalCrossChainFeeBps(consumer, {
        network,
        amount: dto.amount,
        merchantFee: merchant !== null,
        // An EVM link without a deposit address is found by its amount at the
        // merchant's own address, where a payout from another network for the
        // same amount would also land: it would settle the wrong link.
        recognisedByAmount: isEvmChain(chain) && !link.chainReference,
        // Arc: the cross-chain route does not reach it at all.
        routed: isRoutedNetwork(chain),
      }),
      ...depositLimitColumns(dto.depositLimits),
      assetDecimals: link.assetDecimals,
      chainReference: link.chainReference,
      chainCursor: link.chainCursor,
      networkFee: link.networkFee,
      // In the same insert as the intent: a deposit address the service forgot
      // is money at an address nobody can ever move, so the two commit or fail
      // together.
      ...(link.deposit
        ? {
            evmDeposit: {
              create: {
                chain,
                network,
                address: link.deposit.address,
                salt: link.deposit.salt,
                destination: link.deposit.destination,
                token: link.deposit.token,
                relayer: link.deposit.relayer,
                fee: link.deposit.fee.toString(),
                feeWallet: link.deposit.merchantFee?.wallet ?? null,
                merchantFee:
                  link.deposit.merchantFee?.amount.toString() ?? null,
              },
            },
          }
        : {}),
    });
    if (!intent) {
      return this.replayOf(
        await this.findByMemo(localConsumer.id, memo),
        terms,
        merchant?.terms,
      );
    }
    if (transactionRequest) {
      intent = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { uri: this.solanaPayLink(intent.id) },
      });
    }

    this.logger.log(
      `Created PAY payment intent ${intent.id} on ${chain}: ` +
        `${dto.amount ?? '(open)'} ${terms.asset} → ${terms.destination} ` +
        `(consumer=${consumer.username}, network=${network}, memo=${memo})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_CREATED', intent);
    return this.withQr(intent);
  }

  /**
   * A PAY intent on a network beyond Stellar, Solana and Monad: the payer never
   * pays the merchant directly, but a deposit address the cross-chain route
   * makes for that payment (`POST /v1/payment-links/{id}/deposits`), from any
   * network it reaches, and the intent settles when the route reports the
   * merchant paid exactly `amount`. So the link is the hosted checkout, which
   * asks the payer where they pay from; there is no wallet link of its own.
   *
   * What that implies is refused up front: a SEP-7 callback, a merchant fee
   * without an amount, and an asset the route does not trade today. On a test
   * network the sandbox settles the link instead (`SandboxDepositRoute`, in the
   * network's test stablecoin, no commission), where it reaches and without a
   * merchant fee for now. The plan commission such a payment pays is fixed
   * here, from the plan header this request carries.
   */
  private async createPayThroughDeposits(
    consumer: GatewayConsumer,
    chain: DepositNetwork,
    dto: CreatePayPaymentIntentDto,
  ): Promise<PaymentIntentView> {
    if (dto.callback !== undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `callback is a SEP-7 field and is not supported on ${chain}.`,
      );
    }
    if (dto.merchantFee && dto.amount === undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'A merchant fee needs an amount: an open-amount link has nothing to take it from',
      );
    }
    // A `dev` key's link is settled by the sandbox on the network's test
    // network (no commission there); `linkAssetForCreate` refuses one the
    // sandbox does not reach, saying why.
    const network = this.resolveNetwork(consumer);
    const crossChainFeeBps =
      network === 'public'
        ? commissionWithRecipient(
            this.config,
            resolvePlanCommissionBps(this.config, consumer),
            this.config.get('nearIntents', { infer: true }).feeRecipient,
            'NEAR_INTENTS_FEE_RECIPIENT',
          )
        : 0;
    const asset = await this.depositPricing.linkAssetForCreate(
      chain,
      dto.assetCode,
      dto.assetIssuer,
      network,
    );
    // No amount: the payer types it in the checkout, and each deposit is
    // quoted for exactly what they typed.
    if (dto.amount !== undefined) {
      if (decimalPlaces(dto.amount) > asset.decimals) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidAmount,
          `amount has more decimal places than ${asset.symbol} on ${chain} allows (${asset.decimals})`,
        );
      }
      if (parseUnits(dto.amount, asset.decimals) <= 0n) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidAmount,
          'amount must be greater than zero',
        );
      }
    }
    const merchant = this.routeMerchantFee(dto, asset, chain);
    if (merchant && network === 'testnet') {
      throw ApiError.badRequest(
        ApiErrorCode.MerchantFeeUnsupported,
        SANDBOX_MERCHANT_FEE_REFUSAL,
      );
    }

    const localConsumer = await this.resolveConsumer(consumer);
    const memo = resolveOrMintMemoId(dto.memo);
    const terms: PaymentIntentTerms = {
      kind: 'PAY',
      chain,
      network,
      source: null,
      destination: paymentAddressRule(chain).normalize(dto.destination),
      amount: dto.amount ?? null,
      // `native` for the network's coin, as on every other chain.
      asset: asset.contract === null ? 'native' : asset.symbol,
      assetIssuer: asset.contract,
      msg: dto.msg ?? null,
      callback: null,
    };

    const existing = await this.findByMemo(localConsumer.id, memo);
    if (existing) return this.replayOf(existing, terms, merchant?.terms);

    let intent = await this.persist({
      ...terms,
      consumerId: localConsumer.id,
      memo,
      status: 'PENDING',
      xdr: null,
      // The hosted checkout, once the id exists.
      uri: '',
      checkoutTheme: dto.checkoutTheme ?? null,
      assetDecimals: asset.decimals,
      crossChainFeeBps,
      ...merchantFeeColumn(merchant?.record),
      ...depositLimitColumns(dto.depositLimits),
    });
    if (!intent) {
      return this.replayOf(
        await this.findByMemo(localConsumer.id, memo),
        terms,
        merchant?.terms,
      );
    }
    intent = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { uri: this.checkoutLink(intent.id) },
    });

    this.logger.log(
      `Created PAY payment intent ${intent.id} on ${chain} (deposits): ` +
        `${dto.amount ?? '(open)'} ${terms.asset} → ${terms.destination} ` +
        `(consumer=${consumer.username}, network=${network}, memo=${memo})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_CREATED', intent);
    return this.withQr(intent);
  }

  /**
   * A merchant fee on a link paid through deposit addresses: paid by the
   * cross-chain route as an app fee (its own multi-recipient fee support),
   * credited to `merchantFee.wallet`, an account inside the route (a NEAR
   * account id, named or implicit, or an EVM address), not an address on the
   * link's network: the route pays one on-chain recipient, the merchant. The
   * terms are checked here in the link's asset (`fixed`, the share of `amount`);
   * each deposit pays them as whole basis points of what it sends
   * (`PaymentDepositPricing`). Null when the request names none.
   */
  private routeMerchantFee(
    dto: CreatePayPaymentIntentDto,
    asset: { decimals: number; symbol: string; contract: string | null },
    chain: DepositNetwork,
  ): { terms: MerchantFeeTerms; record: MerchantFeeRecord } | null {
    if (!dto.merchantFee || dto.amount === undefined) return null;
    const terms = resolveMerchantFee(
      dto.merchantFee,
      asset.decimals,
      ROUTE_FEE_ACCOUNT_RULE,
    );
    if (!terms) return null;
    if (
      terms.wallet.toLowerCase() ===
      paymentAddressRule(chain).normalize(dto.destination).toLowerCase()
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        "merchantFee.wallet must be another account than the payment's own",
      );
    }
    const split = splitMerchantFee(
      parseUnits(dto.amount, asset.decimals),
      terms,
    );
    assertMerchantFeeCovered(split, terms);
    return {
      terms,
      record: merchantFeeRecord(
        terms,
        split.fee,
        asset.decimals,
        asset.contract === null ? 'native' : asset.symbol,
      ),
    };
  }

  /**
   * The plan commission a payment from another network will pay on a link on
   * Stellar, Solana or Monad, or null when that link cannot take one: a chain
   * the cross-chain route does not reach (Arc), a test network, an open
   * amount, a merchant fee, a link found on its chain by its amount alone, or a
   * rate this deployment cannot charge right now (no plan header, no wallet for
   * the commission). Never in the way of the link: it is created as it always
   * was, only without payments from other networks.
   */
  private optionalCrossChainFeeBps(
    consumer: GatewayConsumer,
    link: {
      network: StellarNetwork;
      amount: string | undefined;
      merchantFee: boolean;
      recognisedByAmount: boolean;
      routed: boolean;
    },
  ): number | null {
    if (
      !link.routed ||
      link.network !== 'public' ||
      link.merchantFee ||
      link.recognisedByAmount
    ) {
      return null;
    }
    try {
      return commissionWithRecipient(
        this.config,
        resolvePlanCommissionBps(this.config, consumer),
        this.config.get('nearIntents', { infer: true }).feeRecipient,
        'NEAR_INTENTS_FEE_RECIPIENT',
      );
    } catch (err) {
      this.logger.warn(
        `Payment link of ${consumer.username} created without payments from other networks: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * A Stellar intent's merchant fee, checked: the wallet a Stellar account that
   * is none of `others` (the destination, a `tx` intent's source), and the fee
   * leaving something for the destination. Null when the request names none.
   */
  private stellarMerchantFee(
    dto: CreatePayPaymentIntentDto | CreateTxPaymentIntentDto,
    asset: ResolvedAsset,
    amount: string,
    others: string[],
  ): StellarMerchantFee | null {
    const terms = resolveMerchantFee(
      dto.merchantFee,
      STELLAR_DECIMALS,
      CHAIN_ADDRESS_RULES.stellar,
    );
    if (!terms) return null;
    if (others.includes(terms.wallet)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        "merchantFee.wallet must be another account than the payment's own",
      );
    }
    const split = splitMerchantFee(toStroops(amount), terms);
    assertMerchantFeeCovered(split, terms);
    const record = merchantFeeRecord(
      terms,
      split.fee,
      STELLAR_DECIMALS,
      asset.code,
    );
    return {
      terms,
      record,
      // `net` is `amount` itself when the payer pays the fee on top.
      destinationAmount: fromStroops(split.net),
    };
  }

  /** A Solana Pay transaction request for intent `id`, on the gateway. */
  private solanaPayLink(id: string): string {
    const { apiUrl } = this.config.get('paymentIntents', { infer: true });
    return `solana:${encodeURIComponent(`${apiUrl}/v1/payment-links/${id}/solana-pay`)}`;
  }

  /** The hosted checkout of intent `id`: where a link with a merchant fee sends its payer. */
  private checkoutLink(id: string): string {
    return `${this.config.get('paymentIntents', { infer: true }).checkoutUrl}/${id}`;
  }

  /**
   * Persists a new intent. Returns null on a (consumer, memo) unique-violation
   * race so the caller can put the winning row through the same replay check
   * as any other retry — losing the race is not a way around it.
   */
  private async persist(
    data: Parameters<PrismaService['paymentIntent']['create']>[0]['data'],
  ): Promise<PaymentIntent | null> {
    // Stamp the lifetime so the observer can expire unpaid intents.
    const ttlSeconds = this.config.get('paymentIntents', {
      infer: true,
    }).ttlSeconds;
    const withTtl = {
      ...data,
      expiresAt: data.expiresAt ?? new Date(Date.now() + ttlSeconds * 1000),
    };
    try {
      return await this.prisma.paymentIntent.create({ data: withTtl });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  // ── READ (list) ─────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    query: QueryPaymentIntentsDto,
  ): Promise<{
    data: PublicPaymentIntent[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      // Only the network this key targets (`resolveNetwork`): a production key never lists a
      // test-network row, nor a sandbox key a mainnet one.
      network: this.resolveNetwork(consumer),
      ...(query.status ? { status: query.status } : {}),
      ...(query.chain ? { chain: query.chain } : {}),
      ...(query.createdFrom ? { createdAt: { gte: query.createdFrom } } : {}),
    };

    // `Promise.all`, not `$transaction`: a snapshot-consistent page and count
    // buys nothing here (the client sees a moving list either way), while the
    // transaction costs four serial round trips — BEGIN, page, count, COMMIT —
    // instead of two issued in parallel.
    const [rows, total] = await Promise.all([
      this.prisma.paymentIntent.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: PAYMENT_INTENT_PUBLIC_SELECT,
      }),
      this.prisma.paymentIntent.count({ where }),
    ]);

    return {
      data: rows.map(toPublicPaymentIntent),
      total,
      take: query.take,
      skip: query.skip,
    };
  }

  // ── READ (one) ──────────────────────────────────────────────────────────────
  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentIntentView> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: this.ownedWhere(consumer, id),
    });

    if (!intent) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    return this.withQr(intent);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdatePaymentIntentDto,
  ): Promise<PaymentIntentView> {
    // Authorize ownership before mutating.
    const chain = await this.assertOwned(consumer, id);
    // A reported transaction must be one of the intent's own chain, stored in
    // that chain's spelling. The DTO admits every chain's shape; only here is
    // the chain known.
    if (dto.txHash !== undefined) {
      dto = { ...dto, txHash: checkedTxId(chain, dto.txHash) };
    }

    // Settling from the API requires the chain to agree.
    //
    // The state machine's only evidence rule for SUCCEEDED is "txHash is a
    // non-empty string", which is a formatting check, not a proof. A
    // `payments:write` key could PATCH `{status:'SUCCEEDED', txHash:'x'}` and
    // mint a settled payment: the terminal webhook fires, the row is counted in
    // the merchant's balances and in the platform-wide admin volume figure, and
    // SUCCEEDED has no outgoing transitions so it never self-corrects.
    //
    // Route it through the same verifier `POST /:id/validate` uses — Horizon
    // lookup by hash, exact-stroop amount match, memo match, `tx.successful`.
    // The internal callers (observer, validate, expiry) still reach
    // `transition` directly; they already hold a verified hash.
    if (dto.status === 'SUCCEEDED') {
      return this.settleFromApi(consumer, id, dto);
    }

    // Every other status change goes through the single guarded entry point.
    if (dto.status) {
      const updated = await this.transition(id, dto.status, {
        consumerUsername: consumer.username,
        actor: 'api',
        reason: 'PATCH /payment-intents/:id',
        txHash: dto.txHash,
      });
      // Non-status fields can still be patched alongside a status change.
      const fields = merchantFieldsOf(dto);
      if (fields) {
        const patched = await this.prisma.paymentIntent.update({
          where: { id },
          data: fields,
        });
        return this.withQr(patched);
      }
      return this.withQr(updated);
    }

    const updated =
      dto.txHash !== undefined
        ? await this.patchTxHash(id, dto.txHash, merchantFieldsOf(dto))
        : await this.prisma.paymentIntent.update({
            where: { id },
            data: merchantFieldsOf(dto) ?? {},
          });

    this.logger.log(
      `Updated payment intent ${id} (consumer=${consumer.username}): status unchanged`,
    );

    await this.emit(consumer.username, 'PAYMENT_INTENT_UPDATED', updated);
    return this.withQr(updated);
  }

  /**
   * Records a reported `txHash` (and any merchant fields sent with it) without
   * a status change. Only a PENDING or SUBMITTED intent accepts a new hash.
   *
   * This branch had no status check, so a terminal intent's hash could be
   * rewritten: a SUCCEEDED row's `txHash` — the transaction its settlement was
   * verified against — swapped for any string, with no transition, no audit row,
   * and a PAYMENT_INTENT_UPDATED webhook broadcasting the new value. The write
   * is a compare-and-swap on the status just read, as in {@link transition}, so
   * an intent that settles in between is refused rather than overwritten.
   * Re-sending the hash the intent already carries changes nothing and stays
   * allowed, so a retried PATCH does not start failing once the intent settles.
   */
  private async patchTxHash(
    id: string,
    txHash: string,
    fields: MerchantFields | null,
  ): Promise<PaymentIntent> {
    const data = { txHash, ...fields };
    const current = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: { status: true, txHash: true },
    });
    if (!current) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    if (current.txHash === txHash) {
      return this.prisma.paymentIntent.update({ where: { id }, data });
    }
    if (isTerminalStatus(current.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `txHash cannot be changed on a ${current.status} payment intent: ` +
          'the status is terminal',
      );
    }

    // A hash already recorded on another of the consumer's intents trips the
    // (consumerId, txHash) index; that is a 409, not a 500.
    let guarded: { count: number };
    try {
      guarded = await this.prisma.paymentIntent.updateMany({
        where: { id, status: current.status },
        data,
      });
    } catch (err) {
      throw txHashConflict(err) ?? err;
    }
    if (guarded.count === 0) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        `Payment intent ${id} status changed concurrently; expected ${current.status}`,
      );
    }
    return this.prisma.paymentIntent.findUniqueOrThrow({ where: { id } });
  }

  /**
   * The API-driven SUCCEEDED path: verify against the chain, then settle.
   *
   * Delegates to {@link validate}, so a PATCH and a `POST /:id/validate` cannot
   * disagree about what counts as settled. A hash the chain does not corroborate
   * is a 400 rather than a silent settlement.
   */
  private async settleFromApi(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdatePaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const current = await this.prisma.paymentIntent.findUnique({
      where: { id },
    });
    if (!current) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }

    // The declared graph and the evidence rule are checked here, before any
    // Horizon call: forcing a CANCELLED or FAILED intent to SUCCEEDED is an
    // invalid transition whatever the chain says, and it must not cost a network
    // round trip or report itself as a rejected transaction. `transition`
    // applies the same assertion again downstream — this is the early, honest
    // error.
    //
    // It is asked as if the chain will agree (`verifiedOnChain: true`), because
    // the question here is whether any settlement could apply: an EXPIRED
    // intent can settle, on exactly the verification `validate` performs below.
    // The real answer is the one `markSucceeded` hands `transition`.
    try {
      assertTransition(current.status, 'SUCCEEDED', {
        txHash: dto.txHash,
        verifiedOnChain: true,
      });
    } catch (err) {
      if (err instanceof InvalidPaymentIntentTransitionError) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidStateTransition,
          err.message,
        );
      }
      throw err;
    }

    const outcome = await this.validate(consumer, id, dto.txHash!.trim());
    if (!outcome.valid) {
      throw ApiError.badRequest(
        ApiErrorCode.TransactionRejected,
        `The transaction does not settle this payment intent: ${
          outcome.reason ?? 'verification failed'
        }`,
      );
    }

    // The merchant's fields may be patched alongside the settlement.
    const fields = merchantFieldsOf(dto);
    if (fields) {
      const patched = await this.prisma.paymentIntent.update({
        where: { id },
        data: fields,
      });
      return this.withQr(patched);
    }
    return outcome.paymentIntent!;
  }

  /**
   * Single status-transition entry point for payment intents (issue #36).
   * Validates the declared graph, requires on-chain evidence for SUCCEEDED,
   * applies an optimistic `status` guard in the UPDATE, and appends an audit row.
   */
  async transition(
    intentId: string,
    to: PaymentIntentStatus,
    opts: TransitionOptions,
  ): Promise<PaymentIntent> {
    const current = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
    });
    if (!current) {
      throw ApiError.notFound(`Payment intent ${intentId} not found`);
    }

    const from = current.status;
    const toStatus = to;
    const txHash = opts.txHash ?? current.txHash ?? undefined;

    try {
      assertTransition(from, toStatus, {
        txHash,
        verifiedOnChain: opts.verifiedOnChain,
      });
    } catch (err) {
      if (err instanceof InvalidPaymentIntentTransitionError) {
        // `from`/`to` were never reachable by an integrator — the exception
        // filter only forwards statusCode/code/error/message — so they move
        // into the message, which already names both ends of the transition.
        throw ApiError.badRequest(
          ApiErrorCode.InvalidStateTransition,
          err.message,
        );
      }
      throw err;
    }

    // For PAY intents the payer is unknown until settlement — record the actual
    // on-chain source so the payment is attributable (and customer stats line up).
    const setSource = {
      ...(opts.payer && !current.source ? { source: opts.payer } : {}),
      // The chain's own time of the settling transaction: a checkout session's
      // proof registered at or after it never counts for the receipt.
      ...(opts.paidAt && !current.paidOnChainAt
        ? { paidOnChainAt: opts.paidAt }
        : {}),
    };

    let updated: PaymentIntent;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const guarded = await tx.paymentIntent.updateMany({
          where: { id: intentId, status: current.status },
          data: {
            status: to,
            ...(txHash !== undefined ? { txHash } : {}),
            ...setSource,
            ...(opts.paidFrom
              ? {
                  paidFrom: opts.paidFrom as unknown as Prisma.InputJsonValue,
                }
              : {}),
          },
        });
        if (guarded.count === 0) {
          throw ApiError.conflict(
            ApiErrorCode.OperationInFlight,
            `Payment intent ${intentId} status changed concurrently; expected ${from}`,
          );
        }

        // The assertion above guarantees a hash on every SUCCEEDED.
        if (to === 'SUCCEEDED') {
          await claimSettlement(tx, current, txHash!);
        }

        await tx.paymentIntentTransition.create({
          data: {
            intentId,
            fromStatus: current.status,
            toStatus: to,
            txHash: txHash ?? null,
            actor: opts.actor,
            reason: opts.reason ?? null,
          },
        });

        return tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      });
    } catch (err) {
      // Settling on a hash another of the consumer's intents already carries:
      // a 409 for validate, a logged failure the observer retries — not a 500.
      // A hash that settled someone else's intent arrives here already mapped
      // (`claimSettlement`), so it is never mistaken for this one.
      throw txHashConflict(err) ?? err;
    }

    this.logger.log(
      `Payment intent ${intentId} transition ${from} → ${to}` +
        (txHash ? ` (tx=${txHash})` : '') +
        ` actor=${opts.actor}`,
    );
    await this.emit(opts.consumerUsername, this.statusEvent(to), updated);

    if (to === 'SUCCEEDED') {
      this.recordPayer(updated, opts.payer);
    }

    return updated;
  }

  /**
   * Adds a settled payment's payer to the merchant's customers: the on-chain
   * source, falling back to the intent's own for TX intents.
   *
   * Fire-and-forget, after the settlement has committed and notified. A
   * customer list that missed an entry must not turn a settled payment into an
   * error for whoever settled it — the observer, or a caller of validate.
   */
  private recordPayer(intent: PaymentIntent, payer?: string): void {
    const account = payer ?? intent.source;
    if (!account || !isChain(intent.chain)) return;
    void this.customers
      .ensureForPayer(intent.consumerId, intent.chain, account)
      .catch((err) =>
        this.logger.warn(
          `Could not auto-create customer for intent ${intent.id}: ${String(err)}`,
        ),
      );
  }

  /** Consultable audit trail for a single intent (scoped to the consumer). */
  async listTransitions(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentIntentTransition[]> {
    await this.assertOwned(consumer, id);
    return this.prisma.paymentIntentTransition.findMany({
      where: { intentId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  /**
   * Deletes an intent that has not been paid.
   *
   * A paid (SUCCEEDED) intent is an immutable record of a settled payment — it
   * must not be deletable. The delete is a compare-and-swap on the status just
   * read, scoped to the consumer, as in {@link transition}: it used to be an
   * unconditional delete by id, so an intent the observer settled between the
   * read and the delete was deleted anyway, its settlement already notified and
   * counted. Now that intent is refused with the 409 every other lost race
   * answers, and a re-read shows it SUCCEEDED.
   */
  async remove(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const owned = this.ownedWhere(consumer, id);
    const existing = await this.prisma.paymentIntent.findFirst({
      where: owned,
    });
    if (!existing) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    if (existing.status === 'SUCCEEDED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        'A paid payment intent cannot be deleted.',
      );
    }
    const guarded = await this.prisma.paymentIntent.deleteMany({
      where: { ...owned, status: existing.status },
    });
    if (guarded.count === 0) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        `Payment intent ${id} status changed concurrently; expected ${existing.status}`,
      );
    }
    this.logger.log(
      `Deleted payment intent ${id} (consumer=${consumer.username})`,
    );
    // `deleteMany` returns no row; the one read above is what was deleted, its
    // status pinned by the guard.
    await this.emit(consumer.username, 'PAYMENT_INTENT_DELETED', existing);
    return { id, deleted: true };
  }

  // ── VALIDATE (manual reconciliation) ─────────────────────────────────────────
  /**
   * Validates a submitted transaction against the intent (memo, age,
   * destination, asset, amount and success). On a confirmed match the intent is
   * finalized to SUCCEEDED and a webhook event fires; if it is this intent's
   * payment but failed on-chain it is marked FAILED. Every other mismatch (wrong
   * amount/memo/hash, an older or unrelated transaction) leaves the status
   * untouched so a correct tx can still be submitted later.
   */
  async validate(
    consumer: GatewayConsumer,
    id: string,
    txHash: string,
  ): Promise<ValidationOutcome> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: this.ownedWhere(consumer, id),
    });
    if (!intent) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    txHash = checkedTxId(paymentNetworkOf(intent.chain), txHash);

    // Already settled — return current state without re-querying the network.
    if (intent.status === 'SUCCEEDED') {
      return {
        valid: true,
        status: 'SUCCEEDED',
        paymentIntent: await this.withQr(intent),
      };
    }

    const result = await this.verifiers
      .for(intent.chain)
      .verifyByHash(intent, txHash);

    if (result.valid) {
      const updated = await this.markSucceeded(
        intent.id,
        consumer.username,
        result.txHash ?? txHash,
        result.payer,
        'validate',
        result.paidAt,
      );
      return {
        valid: true,
        status: 'SUCCEEDED',
        paymentIntent: await this.withQr(updated),
      };
    }

    // This intent's own payment failed on-chain → settle as FAILED. The verifier
    // only says so once memo, age and a payment operation all match: FAILED is
    // terminal, and the hash of any unrelated failed transaction used to reach
    // it. Everything else is a mismatch and changes nothing.
    //
    // Only from a status that may still fail. An EXPIRED intent is worth
    // validating now — a verified payment settles it — and a failed attempt
    // against it is answered as the mismatch it is, not as a 400 for an
    // EXPIRED → FAILED transition the caller never asked for.
    if (result.failedOnChain && canTransition(intent.status, 'FAILED')) {
      const updated = await this.markFailed(
        intent.id,
        consumer.username,
        txHash,
      );
      return {
        valid: false,
        status: 'FAILED',
        reason: result.reason,
        paymentIntent: await this.withQr(updated),
      };
    }

    return { valid: false, status: intent.status, reason: result.reason };
  }

  /**
   * Finalizes an intent as SUCCEEDED and emits the event. Reused by the observer.
   *
   * `txHash` must be a transaction the intent's chain verifier
   * ({@link PaymentVerifiers}) has confirmed pays this intent: this is the settlement that counts as verified on-chain, and
   * the only one that may settle an EXPIRED intent. Both callers — `validate`
   * and the observer — hold that verifier result when they call it.
   *
   * The payment goes to the OLDEST intent it pays: an older intent of another
   * consumer that it also pays refuses this one first
   * ({@link assertOldestClaimant}).
   */
  async markSucceeded(
    intentId: string,
    consumerUsername: string,
    txHash: string,
    payer?: string,
    actor: PaymentIntentTransitionActor = 'validate',
    paidAt?: Date,
  ): Promise<PaymentIntent> {
    await this.assertOldestClaimant(intentId, txHash);
    return this.transition(intentId, 'SUCCEEDED', {
      consumerUsername,
      actor,
      reason: 'on-chain payment confirmed',
      txHash,
      payer,
      paidAt,
      verifiedOnChain: true,
    });
  }

  /**
   * Settles an intent a payment from another network paid: the cross-chain
   * route reported the merchant paid exactly the intent's amount, in its asset,
   * on its network (`settlementRefusal` checked it), with `txHash` the payout
   * transaction there. That report is the verification, as the chain's is for
   * the others, so an EXPIRED intent settles too.
   *
   * The deposit was made for this intent alone, so there is no rival to ask
   * about (`assertOldestClaimant`): the settlement claim still makes the payout
   * settle at most one intent. An intent already settled, cancelled or failed is
   * left as it is and logged (the payer paid twice, or after a cancel: the
   * merchant has the money either way), so a retry by the observer is harmless.
   */
  async settleFromDeposit(
    intentId: string,
    txHash: string,
    paidFrom: PaidFromEntity,
  ): Promise<PaymentIntent | null> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { consumer: { select: { apisixUsername: true } } },
    });
    if (!intent) return null;
    if (!canTransition(intent.status, 'SUCCEEDED')) {
      this.logger.warn(
        `Deposit ${paidFrom.depositId} paid intent ${intentId}, which is ` +
          `${intent.status}: left as it is (payout ${txHash})`,
      );
      return null;
    }
    return this.transition(intentId, 'SUCCEEDED', {
      consumerUsername: intent.consumer.apisixUsername,
      actor: 'observer',
      reason: `paid from ${paidFrom.chain} through a deposit address`,
      // Observed now; the deposit's own session gets the receipt anyway.
      paidAt: new Date(),
      txHash: settlementTxId(paymentNetworkOf(intent.chain), txHash),
      verifiedOnChain: true,
      paidFrom,
    });
  }

  /**
   * Refuses to settle `intentId` on `txHash` when the transaction also pays an
   * older intent of another consumer, with the 409 a hash that already settled
   * one gets (`transaction_already_settled`).
   *
   * The settlement claim makes one transaction settle one intent, but alone it
   * hands the payment to whichever settlement runs first, and a copycat's
   * observer tick can come before the original's: the copy settled and the
   * original, refused at the claim, expired although it was paid. A copy is
   * made of an intent that already exists, so the original is the older; it is
   * refused nothing here (none of its rivals is older) and settles on its own
   * next pass.
   *
   * Which rivals are looked at is `settlement-rivals.ts`; whether one is paid is
   * the chain verifier's answer, the same `verifyByHash` that would settle it.
   * A verifier that cannot answer throws, and the settlement is retried rather
   * than decided without it. Only a rival the chain says is paid refuses this
   * intent — never how many there are: at most `SETTLEMENT_RIVALS_MAX` are
   * asked about, oldest first, and when none of them is paid the claim decides.
   *
   * What concurrency can and cannot do. AT MOST one intent settles on a
   * transaction, always: that is the claim's primary key, whatever this check
   * read. Which one is decided here, without a lock, from statuses read at one
   * moment: a rival counts while PENDING, SUBMITTED or SUCCEEDED, and an intent
   * leaves that set only for EXPIRED, CANCELLED or FAILED — never to come back,
   * except EXPIRED → SUCCEEDED. So:
   *
   * - The oldest intent in that set is never refused here, and a younger one is
   *   refused for as long as the older stays in it. While both are open, the
   *   older wins whichever settlement runs first.
   * - A younger intent is refused only by a rival that was in the set when it
   *   looked. If that rival then leaves it (expires unpaid, is cancelled), the
   *   younger is not refused again, and its next pass settles it: the payment
   *   is never stranded behind an intent that will not take it.
   * - An older intent that EXPIRED no longer outranks anyone. A payment that
   *   reaches it late (`validate` settles EXPIRED) and a younger open intent
   *   then race at the claim, first come. That is the cost of not counting
   *   EXPIRED — see `settlementRivalsQuery`.
   *
   * The same code as an already-settled hash, deliberately: a distinct answer
   * would tell a caller holding a payment that another tenant has an unsettled
   * intent for it.
   */
  private async assertOldestClaimant(
    intentId: string,
    txHash: string,
  ): Promise<void> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
    });
    // A missing intent is `transition`'s 404 to answer. An intent on a network
    // without a verifier of its own settles only through its deposits, never
    // here.
    if (!intent) return;
    const chain = paymentNetworkOf(intent.chain);
    if (!isChain(chain)) return;
    const rivals = await this.prisma.paymentIntent.findMany(
      settlementRivalsQuery(chain, intent),
    );
    if (rivals.length === 0) return;
    const verifier = this.verifiers.for(chain);
    const hash = normalizeTxId(chain, txHash);
    for (const rival of rivals) {
      const result = await verifier.verifyByHash(rival, hash);
      if (result.valid) {
        this.logger.warn(
          `Not settling intent ${intentId} on ${hash}: the payment also pays ` +
            `the older intent ${rival.id} of another consumer`,
        );
        throw transactionAlreadySettled();
      }
    }
  }

  /** Finalizes an intent as FAILED and emits the event. */
  async markFailed(
    intentId: string,
    consumerUsername: string,
    txHash?: string,
    actor: PaymentIntentTransitionActor = 'validate',
  ): Promise<PaymentIntent> {
    return this.transition(intentId, 'FAILED', {
      consumerUsername,
      actor,
      reason: 'on-chain payment failed or rejected',
      txHash,
    });
  }

  /** Finalizes an unpaid, past-lifetime intent as EXPIRED. Reused by the observer. */
  async markExpired(
    intentId: string,
    consumerUsername: string,
    actor: PaymentIntentTransitionActor = 'observer',
  ): Promise<PaymentIntent> {
    return this.transition(intentId, 'EXPIRED', {
      consumerUsername,
      actor,
      reason: 'intent lifetime elapsed before settlement',
    });
  }

  /**
   * Records how far the observer has scanned for an intent's payment (Monad),
   * so its next tick resumes there. Only while the intent is still PENDING: a
   * settled intent needs no cursor, and writing one must not race a
   * settlement's status change.
   */
  async advanceCursor(intentId: string, cursor: string): Promise<void> {
    await this.prisma.paymentIntent.updateMany({
      where: { id: intentId, status: 'PENDING' },
      data: { chainCursor: cursor },
    });
  }

  /**
   * Throws 404 unless the intent exists, belongs to the consumer and is on the
   * key's network, and answers the network it settles on.
   */
  async assertOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentNetwork> {
    const owned = await this.prisma.paymentIntent.findFirst({
      where: this.ownedWhere(consumer, id),
      select: { id: true, chain: true },
    });
    if (!owned) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    return paymentNetworkOf(owned.chain);
  }

  /**
   * The emails payers gave in the hosted checkout of the caller's own intent
   * `id`, newest first: unverified, shown so the merchant can reach a payer
   * when no receipt could be sent (several sessions, none proved the payment).
   */
  async payerEmails(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentPayerEmailListEntity> {
    await this.assertOwned(consumer, id);
    const rows = await this.prisma.paymentPayerSession.findMany({
      where: { intentId: id },
      select: { email: true, lang: true, sentAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: PAYMENT_PAYER_EMAILS_LISTED,
    });
    return {
      data: rows.map(({ createdAt, ...row }) => ({
        ...row,
        recordedAt: createdAt,
      })),
    };
  }
}

/**
 * What a public row stores, resolved into what the owner is answered. It
 * spreads, so it takes only a row already cut to
 * {@link PAYMENT_INTENT_PUBLIC_SELECT} — never a full one.
 */
function toPublicPaymentIntent(
  row: PublicPaymentIntentRow,
): PublicPaymentIntent {
  const { depositMaxPerPayer, depositBudgetPerWindow, ...rest } = row;
  return {
    ...rest,
    checkoutTheme: effectiveCheckoutTheme(row.checkoutTheme),
    merchantFee: readMerchantFeeRecord(row.merchantFee),
    paidFrom: readPaidFrom(row.paidFrom),
    depositLimits: depositLimitsOf({
      depositMaxPerPayer,
      depositBudgetPerWindow,
    }),
  };
}

/** The `merchantFee` column of a new intent: its record, or nothing (null). */
function merchantFeeColumn(record: MerchantFeeRecord | undefined): {
  merchantFee?: Prisma.InputJsonValue;
} {
  return record
    ? { merchantFee: record as unknown as Prisma.InputJsonValue }
    : {};
}

/** The columns a PATCH writes that are the merchant's, not the payment's. */
type MerchantFields = {
  reference?: string;
  checkoutTheme?: CheckoutTheme;
  depositMaxPerPayer?: number;
  depositBudgetPerWindow?: number;
};

/**
 * The merchant's own fields a PATCH sent — its `reference` and the checkout
 * page's design — or null when it sent neither. They prove nothing about the
 * payment, so they are written in any status, with or without a status change.
 */
function merchantFieldsOf(dto: UpdatePaymentIntentDto): MerchantFields | null {
  const fields: MerchantFields = {
    ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
    ...(dto.checkoutTheme !== undefined
      ? { checkoutTheme: dto.checkoutTheme }
      : {}),
    ...depositLimitColumns(dto.depositLimits),
  };
  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * The columns a request's `depositLimits` writes: only the limits it names, so
 * a `PATCH` naming one keeps the other. The DTO already held each between the
 * default and its ceiling.
 */
function depositLimitColumns(limits: DepositLimitsDto | undefined): {
  depositMaxPerPayer?: number;
  depositBudgetPerWindow?: number;
} {
  if (!limits) return {};
  return {
    ...(limits.perPayer !== undefined
      ? { depositMaxPerPayer: limits.perPayer }
      : {}),
    ...(limits.perWindow !== undefined
      ? { depositBudgetPerWindow: limits.perWindow }
      : {}),
  };
}

/**
 * `txHash` checked against the intent's chain and returned in the spelling it
 * is stored in, or a 400 naming the shape that chain expects. An intent on a
 * network beyond Stellar, Solana and Monad takes no reported transaction: it
 * settles only from its deposits, on the cross-chain route's report.
 */
function checkedTxId(chain: PaymentNetwork, txHash: string): string {
  if (!isChain(chain)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `A payment intent on ${chain} settles from the deposit addresses made ` +
        'for its payers: it takes no reported transaction',
    );
  }
  const trimmed = txHash.trim();
  if (!isTxIdFor(chain, trimmed)) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `txHash must be ${expectedTxId(chain)} for a ${chain} payment intent`,
    );
  }
  return normalizeTxId(chain, trimmed);
}

/**
 * Claims `txHash` for `intent`'s settlement, inside the transaction that marks
 * it SUCCEEDED, or throws 409 `transaction_already_settled` when the hash
 * already settled an intent — of any consumer.
 *
 * The (consumerId, txHash) index cannot refuse that on its own: it is per
 * consumer, and a tenant that copies another's destination, amount and memo
 * (the memo is the caller's to choose, and the shared public key is one
 * consumer for every anonymous caller) built an intent the payer's one
 * transaction also verified against. Both settled. Checking for an earlier
 * settlement first and settling after would leave two settlements racing
 * between the read and the write; the primary key decides instead, and the
 * loser's whole transaction — its status change included — rolls back.
 *
 * The violation is mapped here, at the one statement that can raise it: by
 * the time it reaches `transition`'s catch, Prisma's `meta.target` would name
 * `txHash` and {@link txHashConflict} would answer it as a collision among the
 * caller's own intents. The message names no intent and no consumer: the one
 * already paid is not this caller's.
 */
async function claimSettlement(
  tx: Prisma.TransactionClient,
  intent: PaymentIntent,
  txHash: string,
): Promise<void> {
  const chain = paymentNetworkOf(intent.chain);
  try {
    await tx.paymentSettlement.create({
      data: {
        chain,
        network: intent.network,
        txHash: settlementTxId(chain, txHash),
        intentId: intent.id,
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw transactionAlreadySettled();
  }
}

/**
 * A settling transaction in the spelling it is stored and claimed in: the
 * chain's own rule on Stellar, Solana and Monad (`tx-id.ts`), the network's
 * rule in `CROSS_CHAIN_NETWORKS` elsewhere. A payout id the rule does not
 * recognise is kept as the route reported it, trimmed: it still settles the
 * intent, and stays one value in the claim.
 */
function settlementTxId(chain: PaymentNetwork, txHash: string): string {
  const trimmed = txHash.trim();
  if (isChain(chain)) {
    return isTxIdFor(chain, trimmed) ? normalizeTxId(chain, trimmed) : trimmed;
  }
  const rule = CROSS_CHAIN_NETWORKS[chain].txId;
  return rule.isValid(trimmed) ? rule.normalize(trimmed) : trimmed;
}

/**
 * The 409 for a transaction that settles, or already settled, another payment
 * intent. One message for both causes, naming no intent and no consumer: the
 * other intent is not this caller's to learn about.
 */
function transactionAlreadySettled(): ApiError {
  return ApiError.conflict(
    ApiErrorCode.TransactionAlreadySettled,
    'This transaction settles another payment intent. One payment settles ' +
      'at most one intent: the oldest it pays.',
  );
}

/**
 * The 409 for a `txHash` already recorded on another of the consumer's
 * intents, or `null` when `err` is not that violation.
 *
 * `txHash` is unique per consumer: one transaction settles at most one of a
 * consumer's intents. It was unique across every tenant, and PATCH records a
 * reported hash unverified, so any tenant could write another tenant's hash onto
 * an intent of its own. That tenant's settlement then hit the index and escaped
 * as a raw Prisma error — a 500 from validate, a reconcile that failed on every
 * observer tick, and an intent that expired although it was paid. The index is
 * scoped now; a collision that remains is between the consumer's own intents.
 *
 * Which column fired is read through `uniqueViolationColumns`, so it works on
 * both paths: Prisma's `meta.target` names the field, `@prisma/adapter-pg`
 * names the index (`payment_intent_consumerId_txHash_key`) instead — hence the
 * match is on the name containing the column, not on equality. A violation that
 * names another column is left alone. One that names nothing at all is still
 * treated as the txHash: the writes this guards touch no other unique column,
 * and a client that reports neither target nor constraint leaves no better
 * answer than a 409 the caller can act on.
 *
 * The message names no intent. The consumer may be the shared public key's,
 * whose intents belong to every anonymous caller.
 */
function txHashConflict(err: unknown): ApiError | null {
  if (!isUniqueViolation(err)) return null;
  const columns = uniqueViolationColumns(err);
  if (columns.length > 0 && !uniqueViolationNames(err, 'txHash')) return null;
  return ApiError.conflict(
    ApiErrorCode.IdempotencyConflict,
    'This transaction hash is already recorded on another of your payment ' +
      'intents. A transaction settles at most one of them.',
  );
}

/** An EVM address, which the cross-chain route also takes as an account id. */
const EVM_ACCOUNT_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * What a merchant fee's wallet must be on a link paid through deposit
 * addresses: an account inside the cross-chain route, where its app fees are
 * credited. A NEAR account id (named, or 64-hex implicit), or an EVM address,
 * which the route takes as an account of that key (stored lowercase, the
 * route's spelling).
 */
const ROUTE_FEE_ACCOUNT_RULE = {
  isValid: (wallet: string) =>
    CROSS_CHAIN_NETWORKS.near.address.isValid(
      EVM_ACCOUNT_RE.test(wallet) ? wallet.toLowerCase() : wallet,
    ),
  normalize: (wallet: string) =>
    EVM_ACCOUNT_RE.test(wallet) ? wallet.toLowerCase() : wallet,
  expected:
    'an account of the cross-chain route: a NEAR account id (e.g. merchant.near, or 64-hex implicit) or an EVM address (0x + 40 hex)',
};
