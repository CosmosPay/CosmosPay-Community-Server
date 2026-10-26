import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CrossChainSwap, Prisma } from '@generated/prisma/client';
import { type Chain, isChain } from '@/chains/chains.constants';
import { formatUnits, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  commissionWithRecipient,
  resolvePlanCommissionBps,
} from '@/common/plan-commission';
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
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
import { PublicRecordTokens } from '@/common/public-record-token';
import {
  LEGACY_RECORD_TOKEN_ROUTES,
  type LegacyRecordTokenRoute,
} from '@/common/public-record-token.constants';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import {
  type CrossChainAsset,
  resolveCrossChainAsset,
  supportedAssets,
} from '@/cross-chain-swaps/cross-chain-assets';
import {
  CROSS_CHAIN_STATUS_EVENTS,
  isTerminal,
  nextStatus,
} from '@/cross-chain-swaps/cross-chain-swap-transitions';
import {
  CROSS_CHAIN_NETWORKS,
  depositLink,
} from '@/cross-chain-swaps/cross-chain-networks';
import type { CrossChainNetworkId } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { CreateCrossChainSwapDto } from '@/cross-chain-swaps/dto/create-cross-chain-swap.dto';
import { QueryCrossChainSwapsDto } from '@/cross-chain-swaps/dto/query-cross-chain-swaps.dto';
import { QuoteCrossChainSwapDto } from '@/cross-chain-swaps/dto/quote-cross-chain-swap.dto';
import type { CrossChainQuoteEntity } from '@/cross-chain-swaps/entities/cross-chain-swap.entity';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import { NEAR_INTENTS_REFERRAL } from '@/near-intents/near-intents.constants';
import type {
  NearIntentsQuoteRequest,
  NearIntentsQuoteResponse,
  NearIntentsStatusResponse,
} from '@/near-intents/near-intents.types';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { resolveAsset } from '@/stellar/asset';
import { sep7Qr } from '@/stellar/sep7';
import {
  resolveIdempotencyKey,
  resolveSlippage,
} from '@/stellar/stellar-operation-policy';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

/**
 * The columns a cross-chain swap may leave this service with. An allowlist:
 * the row also carries `consumerId`, 1Click's raw quote and the observer's
 * bookkeeping, none of which a caller — least of all one on the shared public
 * key — has any use for.
 */
export const CROSS_CHAIN_SWAP_PUBLIC_SELECT = {
  id: true,
  status: true,
  providerStatus: true,
  network: true,
  originChain: true,
  originAsset: true,
  originContract: true,
  destinationChain: true,
  destinationAsset: true,
  destinationContract: true,
  amountIn: true,
  feeBps: true,
  feeAmount: true,
  merchantFee: true,
  amountOutEstimated: true,
  amountOutMin: true,
  slippageBps: true,
  recipient: true,
  refundTo: true,
  depositAddress: true,
  depositMemo: true,
  depositUri: true,
  depositTxHash: true,
  amountOut: true,
  refundedAmount: true,
  originTxHashes: true,
  destinationTxHashes: true,
  timeEstimateSeconds: true,
  correlationId: true,
  quoteSignature: true,
  idempotencyKey: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CrossChainSwapSelect;

export type PublicCrossChainSwap = Prisma.CrossChainSwapGetPayload<{
  select: typeof CROSS_CHAIN_SWAP_PUBLIC_SELECT;
}>;

/**
 * A public swap plus its QR: of the deposit link when there is one, else of
 * the deposit address (a memo, if any, is in `depositMemo`). Its merchant fee
 * is the stored record read back (null without one).
 */
export type CrossChainSwapView = Omit<PublicCrossChainSwap, 'merchantFee'> & {
  merchantFee: MerchantFeeRecord | null;
  qr: string;
};

/**
 * Where `/v1/swaps` settles a same-chain swap, named in the refusal. Only these
 * three chains have a venue of their own here; on every other network NEAR
 * Intents may swap within the one chain.
 */
const SAME_CHAIN_VENUES: Record<Chain, string> = {
  stellar: 'the Stellar DEX',
  solana: 'Jupiter',
  monad: 'Kuru Flow',
};

/** A swap priced by 1Click — everything quote and create both need. */
interface PricedCrossChainSwap {
  origin: CrossChainAsset;
  destination: CrossChainAsset;
  amountIn: string;
  feeBps: number;
  feeAmount: string;
  /** The merchant fee the request named, as NEAR Intents will pay it; null without one. */
  merchantFee: { terms: MerchantFeeTerms; record: MerchantFeeRecord } | null;
  slippageBps: number;
  recipient: string;
  refundTo: string;
  request: NearIntentsQuoteRequest;
  response: NearIntentsQuoteResponse;
}

/** The terms a stored row is compared on when an Idempotency-Key is reused. */
interface CrossChainRequestTerms {
  originChain: string;
  originAssetId: string;
  destinationChain: string;
  destinationAssetId: string;
  amountIn: string;
  recipient: string;
  refundTo: string;
  slippageBps: number;
  /** Compared with {@link sameMerchantFee}: the stored row keeps its record. */
  merchantFee: MerchantFeeTerms | null;
}

/**
 * Cross-chain swaps between every network NEAR Intents reaches and this service
 * can validate (`CROSS_CHAIN_NETWORKS`), settled by NEAR Intents.
 *
 * Non-custodial, and one step removed from the chain: this service resolves
 * the assets, prices the swap through 1Click with the plan commission as an
 * app fee, and hands the payer a deposit request in their own chain's wallet
 * standard. The payer's deposit goes to an address 1Click derived for this one
 * quote; NEAR Intents' solvers pay the recipient, or refund the payer. Neither
 * leg passes through Cosmos Pay. What happens after the deposit is mirrored by
 * {@link CrossChainSwapObserverService}, which asks 1Click and moves the row.
 *
 * A same-chain pair on Stellar, Solana or Monad is refused here: `/v1/swaps`
 * settles it on the chain's own venue (the Stellar DEX, Jupiter on Solana, Kuru
 * Flow on Monad) with no bridge in between.
 */
@Injectable()
export class CrossChainSwapsService {
  private readonly logger = new Logger(CrossChainSwapsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly consumers: ConsumerResolverService,
    private readonly nearIntents: NearIntentsClient,
    private readonly accounts: StellarAccountLoader,
    private readonly recordTokens: PublicRecordTokens,
  ) {}

  // ── Assets ────────────────────────────────────────────────────────────────
  /** What NEAR Intents can swap on every network this service reaches. */
  async assets(): Promise<{ data: CrossChainAsset[] }> {
    return { data: supportedAssets(await this.nearIntents.tokens()) };
  }

  // ── Quote ─────────────────────────────────────────────────────────────────
  /**
   * A dry 1Click quote: the price, the fee and the minimum, with no deposit
   * address. Answered for `dev` keys too — the price is mainnet's either way,
   * and a quote moves nothing.
   */
  async quote(
    consumer: GatewayConsumer,
    dto: QuoteCrossChainSwapDto,
  ): Promise<CrossChainQuoteEntity> {
    const priced = await this.price(consumer, dto, false);
    const { quote } = priced.response;
    return {
      network: 'public',
      origin: {
        chain: priced.origin.chain,
        asset: priced.origin.symbol,
        assetId: priced.origin.assetId,
        contract: priced.origin.contract,
        amount: priced.amountIn,
        amountUsd: quote.amountInUsd ?? null,
      },
      destination: {
        chain: priced.destination.chain,
        asset: priced.destination.symbol,
        assetId: priced.destination.assetId,
        contract: priced.destination.contract,
        amount: quote.amountOutFormatted,
        amountUsd: quote.amountOutUsd ?? null,
        minimum: this.minimumOut(priced),
      },
      fee: {
        bps: priced.feeBps,
        amount: priced.feeAmount,
        asset: priced.origin.symbol,
      },
      merchantFee: priced.merchantFee?.record ?? null,
      slippageBps: priced.slippageBps,
      timeEstimateSeconds: quote.timeEstimate,
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────
  /**
   * A live 1Click quote — a deposit address for this swap alone — persisted,
   * with the wallet link that pays it.
   *
   * Idempotency: the same `Idempotency-Key` with the same request returns the
   * stored swap and never asks 1Click for a second address; with a different
   * request it is a 409. The key is scoped to the consumer, and on the shared
   * public key every anonymous wallet is the same consumer, so a replay is only
   * answered when the request matches — see {@link replay}.
   *
   * On the shared public key the answer also carries `publicToken`, the
   * swap's read token (`PublicRecordTokens`), the same on a replay.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateCrossChainSwapDto,
    headerIdempotencyKey?: string,
  ): Promise<CrossChainSwapView & { publicToken?: string }> {
    return this.recordTokens.attach(
      consumer,
      'cross-chain-swap',
      await this.build(consumer, dto, headerIdempotencyKey),
    );
  }

  private async build(
    consumer: GatewayConsumer,
    dto: CreateCrossChainSwapDto,
    headerIdempotencyKey?: string,
  ): Promise<CrossChainSwapView> {
    if (resolveNetwork(this.config, consumer) !== 'public') {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        'Cross-chain swaps run on mainnet only: NEAR Intents has no test ' +
          'network. Use a prod API key.',
      );
    }
    const local = await this.consumers.resolve(consumer);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );

    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) {
        return this.replay(existing, await this.requestTerms(dto), consumer);
      }
    }

    const priced = await this.price(consumer, dto, true);
    await this.assertRecipientCanReceive(priced);

    const { quote } = priced.response;
    if (!quote.depositAddress) {
      this.logger.error(
        `1Click answered a live quote without a deposit address (correlationId=${priced.response.correlationId})`,
      );
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'NEAR Intents did not issue a deposit address. Retry shortly.',
      );
    }
    const depositMemo = quote.depositMemo ?? null;
    const depositUri = depositLink({
      address: quote.depositAddress,
      memo: depositMemo,
      amount: priced.amountIn,
      asset: priced.origin,
    });

    const swap = await this.persist({
      consumerId: local.id,
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
      feeBps: priced.feeBps,
      feeAmount: priced.feeAmount,
      ...(priced.merchantFee
        ? {
            merchantFee: priced.merchantFee
              .record as unknown as Prisma.InputJsonValue,
          }
        : {}),
      amountOutEstimated: quote.amountOutFormatted,
      amountOutMin: this.minimumOut(priced),
      slippageBps: priced.slippageBps,
      recipient: priced.recipient,
      refundTo: priced.refundTo,
      depositAddress: quote.depositAddress,
      depositMemo,
      depositUri,
      timeEstimateSeconds: quote.timeEstimate,
      correlationId: priced.response.correlationId,
      quoteSignature: priced.response.signature,
      quote: priced.response as unknown as Prisma.InputJsonValue,
      idempotencyKey,
      expiresAt: new Date(quote.deadline ?? priced.request.deadline),
    });

    if (!swap) {
      // Another request with the same key won the insert.
      const raced = await this.findByIdempotencyKey(local.id, idempotencyKey!);
      if (raced)
        return this.replay(raced, await this.requestTerms(dto), consumer);
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A cross-chain swap with this Idempotency-Key already exists.',
      );
    }

    this.logger.log(
      `Created cross-chain swap ${swap.id}: ${swap.amountIn} ${swap.originAsset}@${swap.originChain} → ` +
        `~${swap.amountOutEstimated} ${swap.destinationAsset}@${swap.destinationChain} ` +
        `(consumer=${consumer.username}, correlationId=${swap.correlationId})`,
    );
    await this.emit(consumer.username, 'CROSS_CHAIN_SWAP_CREATED', swap);
    return this.present(swap);
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    query: QueryCrossChainSwapsDto,
  ): Promise<{
    data: PublicCrossChainSwap[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      // Only the network this key targets (`resolveNetwork`): a production key never lists a
      // test-network row, nor a sandbox key a mainnet one.
      // These swaps are mainnet only (always `public`), so a sandbox key lists none.
      network: resolveNetwork(this.config, consumer),
      ...(query.status ? { status: query.status } : {}),
    };
    // `Promise.all`, not `$transaction` — see `@/common/pagination` for why.
    const [data, total] = await Promise.all([
      this.prisma.crossChainSwap.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: CROSS_CHAIN_SWAP_PUBLIC_SELECT,
      }),
      this.prisma.crossChainSwap.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  /** One swap; the shared public key also needs its record token. */
  async findOne(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
  ): Promise<CrossChainSwapView> {
    return this.present(await this.findOwned(consumer, id, recordToken));
  }

  // ── Deposit ───────────────────────────────────────────────────────────────
  /**
   * Tells NEAR Intents which transaction paid the deposit address, so the swap
   * starts without waiting for its indexer, and records the answer.
   *
   * Nothing here trusts the hash: 1Click reads the origin chain itself and
   * credits only what really arrived at the address. The hash's shape is
   * checked against the origin chain so a typo is a 400 rather than an
   * upstream round-trip.
   */
  async submitDeposit(
    consumer: GatewayConsumer,
    id: string,
    txHash: string,
    recordToken?: string,
  ): Promise<CrossChainSwapView> {
    // A legacy route: the public key may still leave the token out (see
    // `PublicRecordTokens`).
    const swap = await this.findOwned(
      consumer,
      id,
      recordToken,
      LEGACY_RECORD_TOKEN_ROUTES.crossChainDeposit,
    );
    const network =
      CROSS_CHAIN_NETWORKS[swap.originChain as CrossChainNetworkId];
    if (!network.txId.isValid(txHash)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `txHash is not a ${network.id} transaction id: expected ${network.txId.expected}`,
      );
    }
    if (isTerminal(swap.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cross-chain swap ${swap.id} is already ${swap.status}`,
      );
    }
    // Hex is stored lowercase, as everywhere else in this service; base58 and
    // base64 ids are case-sensitive and kept as written.
    const hash = network.txId.normalize(txHash);
    const status = await this.nearIntents.submitDeposit({
      txHash: hash,
      depositAddress: swap.depositAddress,
      ...(swap.depositMemo ? { memo: swap.depositMemo } : {}),
    });
    await this.prisma.crossChainSwap.update({
      where: { id: swap.id },
      data: { depositTxHash: hash },
    });
    return this.present(
      await this.applyProviderStatus(
        { ...swap, depositTxHash: hash },
        status,
        consumer.username,
      ),
    );
  }

  // ── Settlement ────────────────────────────────────────────────────────────
  /**
   * Moves a row to what 1Click reports, and notifies on the move.
   *
   * The status write is a compare-and-swap on the status the row was read
   * with, so the observer and a `/deposit` call racing on one swap produce one
   * transition and one webhook — the terminal ones are also deduplicated by the
   * emitter. Settlement details (amounts, transaction hashes) are recorded
   * whether or not the status moved. `status` null means 1Click did not know
   * the address; only the deadline can move the row then.
   */
  async applyProviderStatus(
    swap: CrossChainSwap,
    status: NearIntentsStatusResponse | null,
    username: string,
  ): Promise<CrossChainSwap> {
    const now = new Date();
    // Unknown to 1Click: nothing to follow, so only our own deadline can move
    // the row — and only one still waiting for its deposit.
    const next = status
      ? nextStatus(swap.status, status.status, now, swap.expiresAt)
      : swap.status === 'AWAITING_DEPOSIT' && now > swap.expiresAt
        ? 'EXPIRED'
        : null;
    const details = status?.swapDetails;
    const data: Prisma.CrossChainSwapUpdateManyMutationInput = {
      lastCheckedAt: now,
      ...(status ? { providerStatus: status.status } : {}),
      ...(details?.amountOutFormatted && details.amountOut !== '0'
        ? { amountOut: details.amountOutFormatted }
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

    if (!next) {
      await this.prisma.crossChainSwap.updateMany({
        where: { id: swap.id, status: swap.status },
        data,
      });
      return { ...swap, ...(data as Partial<CrossChainSwap>) };
    }

    const { count } = await this.prisma.crossChainSwap.updateMany({
      where: { id: swap.id, status: swap.status },
      data: { ...data, status: next },
    });
    const row = await this.prisma.crossChainSwap.findUniqueOrThrow({
      where: { id: swap.id },
    });
    if (count === 1) {
      this.logger.log(
        `Cross-chain swap ${swap.id}: ${swap.status} → ${next} (1Click ${status?.status ?? 'unknown'})`,
      );
      await this.emit(username, CROSS_CHAIN_STATUS_EVENTS[next], row);
    }
    return row;
  }

  // ── Pricing ───────────────────────────────────────────────────────────────
  private async price(
    consumer: GatewayConsumer,
    dto: QuoteCrossChainSwapDto,
    live: boolean,
  ): Promise<PricedCrossChainSwap> {
    if (dto.originChain === dto.destinationChain && isChain(dto.originChain)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `${dto.originChain} → ${dto.originChain} is a same-chain swap: use ` +
          `POST /v1/swaps with chain "${dto.originChain}" (${SAME_CHAIN_VENUES[dto.originChain]}).`,
      );
    }
    const tokens = await this.nearIntents.tokens();
    const origin = resolveCrossChainAsset(
      tokens,
      dto.originChain,
      dto.originAsset,
    );
    const destination = resolveCrossChainAsset(
      tokens,
      dto.destinationChain,
      dto.destinationAsset,
    );
    if (origin.assetId === destination.assetId) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Origin and destination assets must differ for a swap',
      );
    }

    const amountUnits = this.baseUnits(dto.amount, origin);
    // The merchant fee comes out of `amount` (paid by the recipient) or is
    // deposited on top of it (paid by the payer): `total` is the deposit.
    const merchant = this.merchantFeeTerms(dto, origin);
    const split = splitMerchantFee(amountUnits, merchant);
    assertMerchantFeeCovered(split, merchant);
    const baseUnits = split.total;
    const merchantBps = this.merchantAppFeeBps(split, merchant);
    const nearCfg = this.config.get('nearIntents', { infer: true });
    const slippageBps = resolveSlippage(dto.slippageBps, nearCfg);
    // A commission with nowhere to be paid is a misconfiguration, not a free
    // swap: it fails loudly so the operator notices, as Stellar swaps do
    // (waived only by SWAP_COMMISSION_DEV_WAIVER, outside production).
    const feeBps = commissionWithRecipient(
      this.config,
      resolvePlanCommissionBps(this.config, consumer),
      nearCfg.feeRecipient,
      'NEAR_INTENTS_FEE_RECIPIENT',
    );
    const recipient = this.normalizedAddress(
      dto.destinationChain,
      dto.recipient,
    );
    const refundTo = this.normalizedAddress(dto.originChain, dto.refundTo);

    const request: NearIntentsQuoteRequest = {
      dry: !live,
      swapType: 'EXACT_INPUT',
      // 1Click's Stellar deposits are one shared account told apart by memo.
      depositMode: origin.chain === 'stellar' ? 'MEMO' : 'SIMPLE',
      slippageTolerance: slippageBps,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination.assetId,
      amount: baseUnits.toString(),
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(
        Date.now() + nearCfg.deadlineSeconds * 1000,
      ).toISOString(),
      referral: NEAR_INTENTS_REFERRAL,
      ...(feeBps > 0 || merchant
        ? {
            appFees: [
              ...(feeBps > 0
                ? [{ recipient: nearCfg.feeRecipient, fee: feeBps }]
                : []),
              ...(merchant
                ? [{ recipient: merchant.wallet, fee: merchantBps }]
                : []),
            ],
          }
        : {}),
    };
    const response = await this.nearIntents.quote(request);

    return {
      origin,
      destination,
      amountIn: formatUnits(baseUnits, origin.decimals),
      feeBps,
      feeAmount: formatUnits(
        (baseUnits * BigInt(feeBps)) / 10_000n,
        origin.decimals,
      ),
      merchantFee: merchant
        ? {
            terms: merchant,
            // What NEAR Intents will take: the whole basis points of the deposit.
            record: merchantFeeRecord(
              merchant,
              (baseUnits * BigInt(merchantBps)) / 10_000n,
              origin.decimals,
              origin.symbol,
            ),
          }
        : null,
      slippageBps,
      recipient,
      refundTo,
      request,
      response,
    };
  }

  /** The one spelling of `address` on `chain`, stored and sent to 1Click. */
  private normalizedAddress(
    chain: CrossChainNetworkId,
    address: string,
  ): string {
    return CROSS_CHAIN_NETWORKS[chain].address.normalize(address);
  }

  /**
   * The request's merchant fee: the fixed part in the origin asset, the wallet
   * a NEAR account id (NEAR Intents credits app fees to an account inside it).
   */
  private merchantFeeTerms(
    dto: QuoteCrossChainSwapDto,
    origin: CrossChainAsset,
  ): MerchantFeeTerms | null {
    return resolveMerchantFee(
      dto.merchantFee,
      origin.decimals,
      CROSS_CHAIN_NETWORKS.near.address,
    );
  }

  /**
   * The merchant fee as NEAR Intents takes it: whole basis points of the
   * deposit, rounded down so the payer is never charged above what the
   * request states. A fee under one basis point cannot be paid and is refused
   * rather than quietly dropped.
   */
  private merchantAppFeeBps(
    split: { fee: bigint; total: bigint },
    merchant: MerchantFeeTerms | null,
  ): number {
    if (!merchant) return 0;
    const bps = Number((split.fee * 10_000n) / split.total);
    if (bps === 0) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'The merchant fee is under one basis point of the deposit, the least NEAR Intents can pay',
      );
    }
    return bps;
  }

  /** `amount` in the origin asset's base units; a 400 when it cannot be one. */
  private baseUnits(amount: string, asset: CrossChainAsset): bigint {
    let units: bigint;
    try {
      units = parseUnits(amount, asset.decimals);
    } catch {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `amount has more decimal places than ${asset.symbol} on ${asset.chain} allows (${asset.decimals})`,
      );
    }
    if (units <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'amount must be greater than zero',
      );
    }
    return units;
  }

  private minimumOut(priced: PricedCrossChainSwap): string {
    return formatUnits(
      BigInt(priced.response.quote.minAmountOut),
      priced.destination.decimals,
    );
  }

  /**
   * A Stellar recipient must already trust an issued asset, or NEAR Intents'
   * payout fails on-chain and the swap is refunded after the fact. Caught here,
   * with the same loader and message Stellar swaps use for another account:
   * the recipient signs nothing in this flow, so only it can add the trustline.
   */
  private async assertRecipientCanReceive(
    priced: PricedCrossChainSwap,
  ): Promise<void> {
    const { destination, recipient } = priced;
    if (destination.chain !== 'stellar' || !destination.contract) return;
    const account = await this.accounts.load('public', recipient);
    this.accounts.assertCanReceive(
      account.balances,
      resolveAsset(destination.symbol, destination.contract),
      recipient,
      'the swap',
    );
  }

  // ── Idempotency ───────────────────────────────────────────────────────────
  private async requestTerms(
    dto: CreateCrossChainSwapDto,
  ): Promise<CrossChainRequestTerms> {
    const tokens = await this.nearIntents.tokens();
    const origin = resolveCrossChainAsset(
      tokens,
      dto.originChain,
      dto.originAsset,
    );
    const destination = resolveCrossChainAsset(
      tokens,
      dto.destinationChain,
      dto.destinationAsset,
    );
    return {
      originChain: origin.chain,
      originAssetId: origin.assetId,
      destinationChain: destination.chain,
      destinationAssetId: destination.assetId,
      amountIn: formatUnits(
        splitMerchantFee(
          this.baseUnits(dto.amount, origin),
          this.merchantFeeTerms(dto, origin),
        ).total,
        origin.decimals,
      ),
      recipient: this.normalizedAddress(dto.destinationChain, dto.recipient),
      refundTo: this.normalizedAddress(dto.originChain, dto.refundTo),
      slippageBps: resolveSlippage(
        dto.slippageBps,
        this.config.get('nearIntents', { infer: true }),
      ),
      merchantFee: this.merchantFeeTerms(dto, origin),
    };
  }

  /**
   * The stored swap when the reused key came with the same request; a 409 when
   * not. Returning the row unconditionally would hand one anonymous caller
   * another's deposit address — with a refund address the second caller does
   * not control — so the conflict describes nothing about the stored swap.
   */
  private async replay(
    existing: CrossChainSwap,
    terms: CrossChainRequestTerms,
    consumer: GatewayConsumer,
  ): Promise<CrossChainSwapView> {
    const { merchantFee, ...plain } = terms;
    const same =
      (Object.keys(plain) as (keyof typeof plain)[]).every(
        (key) => existing[key] === plain[key],
      ) &&
      sameMerchantFee(
        existing.merchantFee,
        merchantFee,
        existing.originDecimals,
      );
    if (!same) {
      this.logger.warn(
        `Idempotency-Key reused for a different cross-chain swap request ` +
          `(swap=${existing.id}, consumer=${consumer.username})`,
      );
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'This Idempotency-Key was already used for a different cross-chain ' +
          'swap request. Use a new key for a new request.',
      );
    }
    return this.present(existing);
  }

  private findByIdempotencyKey(
    consumerId: string,
    idempotencyKey: string,
  ): Promise<CrossChainSwap | null> {
    return this.prisma.crossChainSwap.findUnique({
      where: { consumerId_idempotencyKey: { consumerId, idempotencyKey } },
    });
  }

  /** Inserts a swap; null when the idempotency key lost a race. */
  private async persist(
    data: Prisma.CrossChainSwapUncheckedCreateInput,
  ): Promise<CrossChainSwap | null> {
    try {
      return await this.prisma.crossChainSwap.create({ data });
    } catch (err) {
      if (isUniqueViolation(err) && data.idempotencyKey) return null;
      throw err;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  /**
   * A miss on someone else's swap is a 404, never a 403. The shared public key
   * also needs the swap's record token; a missing or wrong one is the same
   * 404, decided before the table is read. On a legacy route (`legacyRoute`,
   * the deposit) a missing token is still admitted for now, and logged.
   */
  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
    legacyRoute?: LegacyRecordTokenRoute,
  ): Promise<CrossChainSwap> {
    if (
      !this.recordTokens.admits(
        consumer,
        'cross-chain-swap',
        id,
        recordToken,
        legacyRoute,
      )
    ) {
      throw ApiError.notFound(`Cross-chain swap ${id} not found`);
    }
    const swap = await this.prisma.crossChainSwap.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!swap) throw ApiError.notFound(`Cross-chain swap ${id} not found`);
    if (legacyRoute) {
      this.recordTokens.noteLegacyAccess(
        consumer,
        'cross-chain-swap',
        id,
        recordToken,
        legacyRoute,
      );
    }
    return swap;
  }

  private async present(swap: CrossChainSwap): Promise<CrossChainSwapView> {
    return {
      ...project(swap, CROSS_CHAIN_SWAP_PUBLIC_SELECT),
      merchantFee: readMerchantFeeRecord(swap.merchantFee),
      qr: await sep7Qr(swap.depositUri ?? swap.depositAddress),
    };
  }

  /** Webhooks carry the public projection, never the raw quote. */
  private emit(
    username: string,
    type: Parameters<WebhookTerminalEmitter['emit']>[1],
    swap: CrossChainSwap,
  ): Promise<boolean> {
    return this.webhooks.emit(
      username,
      type,
      project(swap, CROSS_CHAIN_SWAP_PUBLIC_SELECT),
    );
  }
}
