import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeposit, Prisma } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { AppConfig } from '@/config/configuration';
import {
  CROSS_CHAIN_OPEN_STATUSES,
  nextStatus,
} from '@/cross-chain-swaps/cross-chain-swap-transitions';
import {
  CROSS_CHAIN_NETWORKS,
  depositLink,
} from '@/cross-chain-swaps/cross-chain-networks';
import type { NearIntentsStatusResponse } from '@/near-intents/near-intents.types';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  CreatePaymentDepositDto,
  PaymentDepositRequestDto,
} from '@/payment-intents/dto/payment-deposit.dto';
import { PaymentRouteProbe } from '@/payment-intents/payment-route-probe.service';
import type {
  PaymentDepositAssetsEntity,
  PaymentDepositEntity,
  PaymentDepositListEntity,
  PaymentDepositQuoteEntity,
  PaymentRouteCheckListEntity,
} from '@/payment-intents/entities/payment-deposit.entity';
import {
  type PricedPaymentDeposit,
  PaymentDepositPricing,
} from '@/payment-intents/payment-deposit-pricing.service';
import {
  crossChainPaymentRefusal,
  depositLimitsOf,
  requestedAmountOut,
  paidFromRecord,
  paymentDepositClientKey,
  paymentDepositClientSecret,
  paymentDepositClientSubject,
  readTransactions,
  settlementRefusal,
  toPaymentDepositEntity,
} from '@/payment-intents/payment-deposit-rules';
import {
  PAYMENT_DEPOSIT_LOCK_CLASS,
  PAYMENT_DEPOSIT_LINK_WINDOW_MS,
  PAYMENT_DEPOSIT_OWNER_LIST_MAX,
  PAYMENT_DEPOSIT_RESERVATION_MIN_MS,
  PAYMENT_DEPOSIT_REUSE_MIN_REMAINING_MS,
} from '@/payment-intents/payment-intents.constants';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { resolveAsset } from '@/stellar/asset';
import { sep7Qr } from '@/stellar/sep7';

/**
 * The intent columns the deposit routes read: what decides whether it can be
 * paid from another network, and what a payment from one is priced from.
 */
const DEPOSIT_INTENT_SELECT = {
  id: true,
  kind: true,
  chain: true,
  network: true,
  status: true,
  destination: true,
  chainReference: true,
  amount: true,
  asset: true,
  assetIssuer: true,
  assetDecimals: true,
  merchantFee: true,
  crossChainFeeBps: true,
  depositMaxPerPayer: true,
  depositBudgetPerWindow: true,
  expiresAt: true,
} as const satisfies Prisma.PaymentIntentSelect;

type DepositIntent = Prisma.PaymentIntentGetPayload<{
  select: typeof DEPOSIT_INTENT_SELECT;
}>;

/**
 * A create refused because the link's deposit creation budget is spent: `429
 * rate_limited`, the answer every budget here gives, with the seconds until
 * there is room again for the route to put in `Retry-After`. The message says
 * when to retry and nothing about the link.
 */
export class PaymentDepositBudgetError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      ApiErrorCode.RateLimited,
      `Too many requests. Retry in ${retryAfterSeconds}s.`,
    );
  }
}

/**
 * Payments from any network: deposit addresses the cross-chain route makes for
 * one payer of one payment link, and what happens to them.
 *
 * Every route here is keyless (`@Public()`, `/v1/payment-links/{id}/...`): the
 * link's id is the capability, as for its read. What it unlocks is bounded: a
 * quote moves nothing, a deposit address pays only the link's own destination
 * exactly its amount, and refunds only the address the payer names. Nothing here
 * signs or spends: the payer's wallet sends, the route pays. Open deposits are
 * capped per client address ({@link PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT}), so
 * nobody holding a link can take another payer's slots; new ones per link are
 * a refilling budget ({@link PAYMENT_DEPOSIT_LINK_BUDGET} per
 * {@link PAYMENT_DEPOSIT_LINK_WINDOW_MS}, `429` past it), so rotating addresses
 * cannot open unbounded upstream deposit addresses on one link, and spending it
 * locks nobody out for longer than the window.
 *
 * Settlement is the route's report, mirrored by `PaymentDepositObserverService`
 * through {@link applyProviderStatus}: a deposit the route reports SUCCEEDED
 * settles its intent (`PaymentIntentsService.settleFromDeposit`) with the
 * payout transaction on the intent's network as `txHash`.
 */
@Injectable()
export class PaymentDepositsService {
  private readonly logger = new Logger(PaymentDepositsService.name);
  private clientSecret?: Buffer;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly pricing: PaymentDepositPricing,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly accounts: StellarAccountLoader,
    private readonly probe: PaymentRouteProbe,
  ) {}

  /**
   * What the payer of link `id` can pay from, and, for a link with a fixed
   * amount, how the main origins fare for that amount (`routes`: a route
   * below its own minimum is not available, with the reason), so the checkout
   * can disable them before a payer picks one.
   */
  async assets(id: string): Promise<PaymentDepositAssetsEntity> {
    const intent = await this.payableIntent(id, false);
    const [data, routes] = await Promise.all([
      this.pricing.payableAssets(),
      this.probe.check(intent),
    ]);
    return { data, routes };
  }

  /** What paying link `id` from one origin asset costs. Stores nothing. */
  async quote(
    id: string,
    request: PaymentDepositRequestDto,
  ): Promise<PaymentDepositQuoteEntity> {
    const intent = await this.payableIntent(id, true);
    const priced = await this.pricing.price(intent, request, false);
    const { quote } = priced.response;
    return {
      origin: {
        chain: priced.origin.chain,
        asset: priced.origin.symbol,
        assetId: priced.origin.assetId,
        contract: priced.origin.contract,
        amount: priced.amountIn,
        minimum: priced.minAmountIn,
        amountUsd: quote.amountInUsd ?? null,
      },
      destination: {
        chain: priced.destination.chain,
        asset: priced.destination.symbol,
        contract: priced.destination.contract,
        amount: priced.amountOut,
        amountUsd: quote.amountOutUsd ?? null,
      },
      fee: {
        bps: priced.feeBps,
        amount: priced.feeAmount,
        asset: priced.origin.symbol,
      },
      timeEstimateSeconds: quote.timeEstimate,
    };
  }

  /**
   * A deposit address for one payer of link `id`, from a live quote.
   *
   * The same client asking again for the same origin asset and refund address
   * (the amount is the link's) while its earlier deposit still waits with time
   * left gets that deposit back, so a reloaded checkout shows the same address.
   * Otherwise the caller needs a free slot: at most
   * {@link PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT} open deposits of its own
   * (`409`), and room in the link's creation budget (`429`,
   * {@link PaymentDepositBudgetError}). An unpaid deposit past its deadline
   * counts for neither. The slot is taken under the link's lock BEFORE the
   * quote and released after, so concurrent requests cannot all pass the
   * checks and then insert, and the slow quote never holds the lock or a
   * database connection. `ip` is the caller's address (`clientIp(req)`).
   */
  async create(
    id: string,
    request: CreatePaymentDepositDto,
    ip: string,
  ): Promise<PaymentDepositEntity> {
    const intent = await this.payableIntent(id, true);
    // What the merchant is to receive, as stored: the link's own amount, or the
    // one the payer typed on a link without one. Checked again by the quote.
    const amountOut = requestedAmountOut(intent, request.amount);
    const refundTo = CROSS_CHAIN_NETWORKS[
      request.originChain
    ].address.normalize(request.refundTo);
    const origin = await this.pricing.originAsset(
      request.originChain,
      request.originAsset,
    );
    const clientKey = paymentDepositClientKey(
      this.clientKeySecret(),
      paymentDepositClientSubject(ip),
    );
    const reusable = await this.prisma.paymentDeposit.findFirst({
      where: {
        intentId: intent.id,
        clientKey,
        status: 'AWAITING_DEPOSIT',
        originAssetId: origin.assetId,
        // The refund address is part of the quote: another one is another
        // deposit (a payer correcting a typo must not get the old one back).
        refundTo,
        // On a link without an amount, another amount is another payment.
        ...(intent.amount === null && amountOut !== null ? { amountOut } : {}),
        expiresAt: {
          gte: new Date(Date.now() + PAYMENT_DEPOSIT_REUSE_MIN_REMAINING_MS),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (reusable) return this.present(reusable);

    const slot = await this.reserveSlot(intent, clientKey);
    try {
      return await this.open(intent, request, refundTo, clientKey);
    } finally {
      // Once the deposit row exists it counts for itself; on a failed quote the
      // slot is the caller's again. Never in the way of the answer.
      await this.prisma.paymentDepositReservation
        .deleteMany({ where: { id: slot.id } })
        .catch((err: unknown) =>
          this.logger.warn(
            `Deposit slot ${slot.id} of intent ${intent.id} not released (it lapses on its own): ${String(err)}`,
          ),
        );
    }
  }

  /**
   * Takes a slot on link `intentId` for the caller, or refuses: `409` when the
   * caller has its open deposits on the link already, `429` with `Retry-After`
   * when the link's creation budget for the window is spent. Under a
   * transaction-scoped advisory lock on the link, so both checks and the
   * reservation are one step for every replica: two requests that both saw
   * room cannot both take it. Slots whose process died (past `expiresAt`) are
   * swept first.
   */
  private reserveSlot(
    intent: DepositIntent,
    clientKey: string,
  ): Promise<{ id: string }> {
    const intentId = intent.id;
    const limits = depositLimitsOf(intent);
    const { timeoutMs } = this.config.get('nearIntents', { infer: true });
    const holdMs = Math.max(PAYMENT_DEPOSIT_RESERVATION_MIN_MS, 3 * timeoutMs);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAYMENT_DEPOSIT_LOCK_CLASS}::int, hashtext(${intentId}))`;
      const now = new Date();
      await tx.paymentDepositReservation.deleteMany({
        where: { intentId, expiresAt: { lte: now } },
      });
      const openDeposit = {
        intentId,
        status: { in: [...CROSS_CHAIN_OPEN_STATUSES] },
        expiresAt: { gt: now },
      };
      const mine =
        (await tx.paymentDeposit.count({
          where: { ...openDeposit, clientKey },
        })) +
        (await tx.paymentDepositReservation.count({
          where: { intentId, clientKey },
        }));
      if (mine >= limits.perPayer) {
        throw ApiError.conflict(
          ApiErrorCode.OperationInFlight,
          `You already have ${limits.perPayer} open deposit ` +
            'addresses for this payment link: pay one of them, or try again ' +
            'once they expire.',
        );
      }
      // The link's creation budget: deposits created in the window, plus the
      // slots being opened right now (they become deposits in a moment).
      const windowStart = new Date(
        now.getTime() - PAYMENT_DEPOSIT_LINK_WINDOW_MS,
      );
      const recent = await tx.paymentDeposit.findMany({
        where: { intentId, createdAt: { gte: windowStart } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      const opening = await tx.paymentDepositReservation.count({
        where: { intentId },
      });
      if (recent.length + opening >= limits.perWindow) {
        // Room returns when the oldest creation leaves the window; with only
        // slots in flight, as soon as one of them settles.
        const freesAt = recent.length
          ? recent[0].createdAt.getTime() + PAYMENT_DEPOSIT_LINK_WINDOW_MS
          : now.getTime() + 1000;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((freesAt - now.getTime()) / 1000),
        );
        this.logger.warn(
          `Payment intent ${intentId}: deposit creation budget spent ` +
            `(${limits.perWindow} per ${PAYMENT_DEPOSIT_LINK_WINDOW_MS / 1000}s); retry in ${retryAfterSeconds}s`,
        );
        throw new PaymentDepositBudgetError(retryAfterSeconds);
      }
      return tx.paymentDepositReservation.create({
        data: {
          intentId,
          clientKey,
          expiresAt: new Date(now.getTime() + holdMs),
        },
        select: { id: true },
      });
    });
  }

  /** The live quote and its row, once the caller holds a slot. */
  private async open(
    intent: DepositIntent,
    request: CreatePaymentDepositDto,
    refundTo: string,
    clientKey: string,
  ): Promise<PaymentDepositEntity> {
    const priced = await this.pricing.price(intent, request, true);
    await this.assertRecipientCanReceive(priced);

    const { quote } = priced.response;
    if (!quote.depositAddress) {
      this.logger.error(
        `1Click answered a live quote without a deposit address (correlationId=${priced.response.correlationId})`,
      );
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'The cross-chain route did not issue a deposit address. Retry shortly.',
      );
    }
    const depositMemo = quote.depositMemo ?? null;
    let deposit: PaymentDeposit;
    try {
      deposit = await this.prisma.paymentDeposit.create({
        data: {
          intentId: intent.id,
          network: 'public',
          status: 'AWAITING_DEPOSIT',
          providerStatus: 'PENDING_DEPOSIT',
          originChain: priced.origin.chain,
          originAsset: priced.origin.symbol,
          originAssetId: priced.origin.assetId,
          originContract: priced.origin.contract,
          originDecimals: priced.origin.decimals,
          destinationChain: priced.destination.chain,
          destinationAsset: priced.destination.symbol,
          destinationAssetId: priced.destination.assetId,
          destinationContract: priced.destination.contract,
          destinationDecimals: priced.destination.decimals,
          amountIn: priced.amountIn,
          minAmountIn: priced.minAmountIn,
          amountOut: priced.amountOut,
          feeBps: priced.feeBps,
          feeAmount: priced.feeAmount,
          slippageBps: priced.slippageBps,
          recipient: priced.recipient,
          refundTo,
          clientKey,
          payerEmail: request.email.trim().toLowerCase(),
          payerLang: request.lang ?? 'en',
          ...(priced.merchantFee
            ? {
                merchantFee:
                  priced.merchantFee as unknown as Prisma.InputJsonValue,
              }
            : {}),
          depositAddress: quote.depositAddress,
          depositMemo,
          depositUri: depositLink({
            address: quote.depositAddress,
            memo: depositMemo,
            amount: priced.amountIn,
            asset: priced.origin,
          }),
          timeEstimateSeconds: quote.timeEstimate,
          correlationId: priced.response.correlationId,
          quoteSignature: priced.response.signature,
          quote: priced.response as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(quote.deadline ?? priced.request.deadline),
        },
      });
    } catch (err) {
      // The route never hands out one address twice; a collision is its fault,
      // and the payer should simply ask again.
      if (isUniqueViolation(err)) {
        throw ApiError.badGateway(
          ApiErrorCode.ProviderError,
          'The cross-chain route issued a deposit address already in use. Retry shortly.',
        );
      }
      throw err;
    }
    this.logger.log(
      `Opened deposit ${deposit.id} for payment intent ${intent.id}: ` +
        `${deposit.amountIn} ${deposit.originAsset}@${deposit.originChain} → ` +
        `${deposit.amountOut} ${deposit.destinationAsset}@${deposit.destinationChain} ` +
        `(correlationId=${deposit.correlationId})`,
    );
    return this.present(deposit);
  }

  /** One deposit of link `id`, as its payer polls it. */
  async findPublic(
    id: string,
    depositId: string,
  ): Promise<PaymentDepositEntity> {
    const deposit = await this.prisma.paymentDeposit.findFirst({
      where: { id: depositId, intentId: id },
    });
    if (!deposit) {
      throw ApiError.notFound(`Deposit ${depositId} not found`);
    }
    return this.present(deposit);
  }

  /** How the main origins fare for the amount of the caller's own intent `id`. */
  async routeCheck(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentRouteCheckListEntity> {
    await this.paymentIntents.assertOwned(consumer, id);
    const intent = await this.prisma.paymentIntent.findUniqueOrThrow({
      where: { id },
      select: DEPOSIT_INTENT_SELECT,
    });
    return { data: await this.probe.check(intent) };
  }

  /** The deposits of the caller's own intent `id`, newest first. */
  async listForOwner(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentDepositListEntity> {
    await this.paymentIntents.assertOwned(consumer, id);
    const rows = await this.prisma.paymentDeposit.findMany({
      where: { intentId: id },
      orderBy: { createdAt: 'desc' },
      take: PAYMENT_DEPOSIT_OWNER_LIST_MAX,
    });
    return { data: await Promise.all(rows.map((row) => this.present(row))) };
  }

  /**
   * Moves a deposit to what the route reports, and settles its intent when the
   * route reports the merchant paid. The status write is a compare-and-swap on
   * the status the row was read with, so two ticks racing on one deposit make
   * one move; settlement details are recorded either way. `status` null means
   * the route does not know the address: only the deadline can move it then.
   */
  async applyProviderStatus(
    deposit: PaymentDeposit,
    status: NearIntentsStatusResponse | null,
  ): Promise<PaymentDeposit> {
    const now = new Date();
    const next = status
      ? nextStatus(deposit.status, status.status, now, deposit.expiresAt)
      : deposit.status === 'AWAITING_DEPOSIT' && now > deposit.expiresAt
        ? 'EXPIRED'
        : null;
    const details = status?.swapDetails;
    const data: Prisma.PaymentDepositUpdateManyMutationInput = {
      lastCheckedAt: now,
      ...(status ? { providerStatus: status.status } : {}),
      ...(details?.amountOutFormatted && details.amountOut !== '0'
        ? { amountOutPaid: details.amountOutFormatted }
        : {}),
      ...(details?.refundedAmountFormatted && details.refundedAmount !== '0'
        ? { refundedAmount: details.refundedAmountFormatted }
        : {}),
      ...(details?.originChainTxHashes?.length
        ? {
            originTxHashes:
              details.originChainTxHashes as unknown as Prisma.InputJsonValue,
          }
        : {}),
      ...(details?.destinationChainTxHashes?.length
        ? {
            destinationTxHashes:
              details.destinationChainTxHashes as unknown as Prisma.InputJsonValue,
          }
        : {}),
    };
    await this.prisma.paymentDeposit.updateMany({
      where: { id: deposit.id, status: deposit.status },
      data: next ? { ...data, status: next } : data,
    });
    const row = await this.prisma.paymentDeposit.findUniqueOrThrow({
      where: { id: deposit.id },
    });
    if (next && row.status === next) {
      this.logger.log(
        `Deposit ${deposit.id}: ${deposit.status} → ${next} (1Click ${status?.status ?? 'unknown'})`,
      );
    }
    if (row.status === 'SUCCEEDED') await this.settle(row);
    return row;
  }

  /**
   * Settles the intent a SUCCEEDED deposit paid, when the route's report holds
   * up (`settlementRefusal`). Idempotent: an intent already settled, cancelled
   * or failed is left as it is (the merchant was paid anyway, and the warning
   * says so), so the observer can call it again for a deposit whose earlier
   * settlement did not finish.
   */
  async settle(deposit: PaymentDeposit): Promise<void> {
    if (!deposit.intentId) return;
    const payouts = readTransactions(deposit.destinationTxHashes);
    const refusal = settlementRefusal(deposit, payouts);
    if (refusal) {
      this.logger.warn(
        `Deposit ${deposit.id} SUCCEEDED but does not settle intent ${deposit.intentId}: ${refusal}`,
      );
      return;
    }
    await this.paymentIntents.settleFromDeposit(
      deposit.intentId,
      payouts![0].hash,
      paidFromRecord(deposit),
    );
  }

  /**
   * The intent `id` when a payer may pay it from another network, else the
   * reason as a 400 (a 404 for an unknown id). `open`: it must also still be
   * open for payment (PENDING and before its lifetime ends), which a quote and
   * a deposit need and the asset list does not.
   */
  private async payableIntent(
    id: string,
    open: boolean,
  ): Promise<DepositIntent> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: DEPOSIT_INTENT_SELECT,
    });
    if (!intent) throw ApiError.notFound(`Payment intent ${id} not found`);
    const refusal = crossChainPaymentRefusal(intent);
    if (refusal) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `This payment link cannot be paid from another network: ${refusal}.`,
      );
    }
    if (
      open &&
      (intent.status !== 'PENDING' ||
        (intent.expiresAt !== null && intent.expiresAt <= new Date()))
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Payment intent ${id} is ${intent.status === 'PENDING' ? 'EXPIRED' : intent.status}: it can no longer be paid`,
      );
    }
    return intent;
  }

  /**
   * A Stellar merchant must already trust an issued asset, or the payout fails
   * on-chain and the payer is refunded after the fact. Caught before an address
   * is handed out, with the message every other Stellar recipient gets: only
   * that account can add the trustline.
   */
  private async assertRecipientCanReceive(
    priced: PricedPaymentDeposit,
  ): Promise<void> {
    const { destination, recipient } = priced;
    if (destination.chain !== 'stellar' || !destination.contract) return;
    const account = await this.accounts.load('public', recipient);
    this.accounts.assertCanReceive(
      account.balances,
      resolveAsset(destination.symbol, destination.contract),
      recipient,
      'the payment',
    );
  }

  /** The key client addresses are stored under, derived once. */
  private clientKeySecret(): Buffer {
    this.clientSecret ??= paymentDepositClientSecret(
      this.config.get('apisix', { infer: true }).gatewaySecret,
    );
    return this.clientSecret;
  }

  private async present(row: PaymentDeposit): Promise<PaymentDepositEntity> {
    return toPaymentDepositEntity(
      row,
      await sep7Qr(row.depositUri ?? row.depositAddress),
    );
  }
}
