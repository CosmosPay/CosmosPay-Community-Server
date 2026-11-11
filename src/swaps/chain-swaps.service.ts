import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ChainSwap,
  Prisma,
  SwapStatus,
  WebhookEventType,
} from '@generated/prisma/client';
import { CHAIN_ADDRESS_RULES, normalizeAddress } from '@/chains/chain-address';
import {
  assertMerchantFeeCovered,
  type MerchantFeeRecord,
  type MerchantFeeTerms,
  merchantFeeRecord,
  resolveMerchantFee,
  sameMerchantFee,
  splitMerchantFee,
} from '@/common/merchant-fee/merchant-fee';
import type { OtherChain } from '@/chains/chains.constants';
import { formatUnits, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  commissionForSource,
  commissionWithRecipient,
  resolvePlanCommissionBps,
} from '@/common/plan-commission';
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
import { PublicRecordTokens } from '@/common/public-record-token';
import type { LegacyRecordTokenRoute } from '@/common/public-record-token.constants';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import {
  resolveIdempotencyKey,
  resolveSlippage,
} from '@/stellar/stellar-operation-policy';
import { CreateSwapDto } from '@/swaps/dto/create-swap.dto';
import { QuerySwapsDto } from '@/swaps/dto/query-swaps.dto';
import { QuoteSwapDto } from '@/swaps/dto/quote-swap.dto';
import type { SwapQuoteEntity } from '@/swaps/entities/swap.entity';
import {
  CHAIN_SWAP_PROVIDERS,
  CHAIN_SWAP_TX_TTL_MS,
  SWAP_COMMISSION_MEMO,
} from '@/swaps/swaps.constants';
import type {
  ChainSwapVenue,
  VenueAsset,
  VenueRequest,
} from '@/swaps/venues/chain-swap-venue';
import { MonadSwapVenue } from '@/swaps/venues/monad-swap.venue';
import { SolanaSwapVenue } from '@/swaps/venues/solana-swap.venue';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

/**
 * The columns a Solana or Monad swap may leave this service with. The row also
 * carries `consumerId`, the aggregator's raw quote and the observer's
 * bookkeeping; none of it is the caller's.
 */
export const CHAIN_SWAP_PUBLIC_SELECT = {
  id: true,
  chain: true,
  network: true,
  provider: true,
  status: true,
  source: true,
  sendAsset: true,
  sendAmount: true,
  destAsset: true,
  destEstimated: true,
  destMin: true,
  feeBps: true,
  feeAmount: true,
  merchantFee: true,
  slippageBps: true,
  path: true,
  transaction: true,
  approval: true,
  txHash: true,
  idempotencyKey: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ChainSwapSelect;

export type PublicChainSwap = Prisma.ChainSwapGetPayload<{
  select: typeof CHAIN_SWAP_PUBLIC_SELECT;
}>;

/** Result of relaying a signed Solana or Monad swap. */
export interface ChainSwapSubmitOutcome {
  submitted: boolean;
  status: SwapStatus;
  txHash: string;
  swap: PublicChainSwap;
}

/** A priced request, before or after building. */
interface Priced {
  chain: OtherChain;
  /** The gross amount the request named (`request.amount` is what is routed). */
  amount: bigint;
  /** The merchant fee, in the source asset; null without one. */
  merchantFee: { terms: MerchantFeeTerms; record: MerchantFeeRecord } | null;
  request: VenueRequest;
}

/** What a stored swap is compared on when an Idempotency-Key is reused. */
interface ChainSwapTerms {
  chain: string;
  source: string;
  sendAsset: string;
  sendAmount: string;
  destAsset: string;
  slippageBps: number;
}

/** A priced request that names its wallet — what building needs. */
type BuildRequest = VenueRequest & { source: string };

/**
 * Same-chain swaps off Stellar, behind `/v1/swaps` with a `chain`: Solana
 * through Jupiter, Monad through Kuru Flow — the aggregators that route across
 * every liquidity source on their chain, so a swap gets the chain's best rate.
 *
 * Non-custodial, like the Stellar swaps: the aggregator builds the transaction,
 * the wallet signs it, and {@link submit} checks it is exactly the one handed
 * out before broadcasting it through this service's own RPC. The plan
 * commission is the aggregator's integrator fee, paid to the operator's wallet
 * out of the output. Each chain is a {@link ChainSwapVenue} in a `Record`, and
 * nothing here branches on which one.
 */
@Injectable()
export class ChainSwapsService {
  private readonly logger = new Logger(ChainSwapsService.name);
  private readonly venues: Record<OtherChain, ChainSwapVenue>;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly consumers: ConsumerResolverService,
    solana: SolanaSwapVenue,
    monad: MonadSwapVenue,
    private readonly recordTokens: PublicRecordTokens,
  ) {
    this.venues = { solana, monad };
  }

  // ── Quote ─────────────────────────────────────────────────────────────────
  /** Prices a swap through the chain's aggregator. Persists nothing. */
  async quote(
    consumer: GatewayConsumer,
    dto: QuoteSwapDto,
  ): Promise<SwapQuoteEntity & { chain: OtherChain; provider: string }> {
    const priced = await this.price(consumer, dto, dto.sourceAssetCode);
    const quote = await this.venues[priced.chain].quote(priced.request);
    const { send, dest } = priced.request;
    const sendAmount = formatUnits(priced.amount, send.decimals);
    const routed = formatUnits(priced.request.amount, send.decimals);
    return {
      network: 'public',
      chain: priced.chain,
      provider: CHAIN_SWAP_PROVIDERS[priced.chain],
      source: { asset: send.asset, issuer: null, amount: sendAmount },
      fee: {
        asset: dest.asset,
        issuer: null,
        amount: formatUnits(quote.feeAmount, dest.decimals),
        bps: priced.request.feeBps,
        wallet: priced.request.feeWallet,
        label: SWAP_COMMISSION_MEMO,
      },
      // The input is routed (less a merchant fee the recipient pays): the
      // commission comes out of the output.
      swap: { asset: send.asset, issuer: null, amount: routed },
      merchantFee: priced.merchantFee?.record ?? null,
      destination: {
        asset: dest.asset,
        issuer: null,
        estimated: formatUnits(quote.destEstimated, dest.decimals),
        minimum: formatUnits(quote.destMin, dest.decimals),
        slippageBps: priced.request.slippageBps,
      },
      path: quote.path,
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned transaction and persists it. Idempotency as on
   * Stellar: the same key with the same request returns the stored swap (no
   * second build); with a different request, 409 — and the conflict says
   * nothing about the stored swap, because on the shared public key whoever
   * reuses a key may not be who created it.
   *
   * On the shared public key the answer carries `publicToken`, the swap's read
   * token (`PublicRecordTokens`), the same on a replay.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateSwapDto,
    headerIdempotencyKey?: string,
  ): Promise<PublicChainSwap & { publicToken?: string }> {
    return this.recordTokens.attach(
      consumer,
      'chain-swap',
      await this.build(consumer, dto, headerIdempotencyKey),
    );
  }

  private async build(
    consumer: GatewayConsumer,
    dto: CreateSwapDto,
    headerIdempotencyKey?: string,
  ): Promise<PublicChainSwap> {
    const priced = await this.price(consumer, dto, dto.sourceAssetCode);
    const local = await this.consumers.resolve(consumer);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );
    const terms = this.termsOf(priced);

    if (idempotencyKey) {
      const existing = await this.findByKey(local.id, idempotencyKey);
      if (existing) return this.replay(existing, terms, consumer, priced);
    }

    const { chain } = priced;
    const request = priced.request as BuildRequest;
    const built = await this.venues[chain].build(request);
    const row = await this.persist({
      consumerId: local.id,
      chain,
      network: 'public',
      provider: CHAIN_SWAP_PROVIDERS[chain],
      status: 'PENDING',
      source: request.source,
      sendAsset: request.send.asset,
      sendDecimals: request.send.decimals,
      sendAmount: terms.sendAmount,
      destAsset: request.dest.asset,
      destDecimals: request.dest.decimals,
      destEstimated: formatUnits(built.destEstimated, request.dest.decimals),
      destMin: formatUnits(built.destMin, request.dest.decimals),
      feeBps: request.feeBps,
      feeAmount: formatUnits(built.feeAmount, request.dest.decimals),
      ...(priced.merchantFee
        ? {
            merchantFee: priced.merchantFee
              .record as unknown as Prisma.InputJsonValue,
          }
        : {}),
      slippageBps: request.slippageBps,
      path: built.path as unknown as Prisma.InputJsonValue,
      transaction: built.transaction as Prisma.InputJsonValue,
      approval: (built.approval ?? undefined) as
        Prisma.InputJsonValue | undefined,
      quote: built.raw as Prisma.InputJsonValue,
      idempotencyKey,
      expiresAt: new Date(Date.now() + CHAIN_SWAP_TX_TTL_MS[chain]),
    });

    if (!row) {
      const raced = await this.findByKey(local.id, idempotencyKey!);
      if (raced) return this.replay(raced, terms, consumer, priced);
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A swap with this Idempotency-Key already exists.',
      );
    }
    this.logger.log(
      `Created ${chain} swap ${row.id} via ${row.provider}: ${row.sendAmount} ${row.sendAsset} → ` +
        `~${row.destEstimated} ${row.destAsset} (consumer=${consumer.username})`,
    );
    await this.emit(consumer.username, 'SWAP_CREATED', row);
    return project(row, CHAIN_SWAP_PUBLIC_SELECT);
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    chain: OtherChain,
    query: QuerySwapsDto,
  ): Promise<{
    data: PublicChainSwap[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      chain,
      consumer: { apisixUsername: consumer.username },
      // Only the network this key targets (`resolveNetwork`): a production key never lists a
      // test-network row, nor a sandbox key a mainnet one.
      // These swaps are mainnet only (always `public`), so a sandbox key lists none.
      network: resolveNetwork(this.config, consumer),
      ...(query.status ? { status: query.status } : {}),
    };
    // `Promise.all`, not `$transaction` — see `@/common/pagination` for why.
    const [data, total] = await Promise.all([
      this.prisma.chainSwap.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: CHAIN_SWAP_PUBLIC_SELECT,
      }),
      this.prisma.chainSwap.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  /**
   * The caller's Solana or Monad swap by id, or null when it has none — the
   * `/v1/swaps/{id}` routes then fall through to the Stellar table, whose 404
   * is the one a miss has always answered. Only on the network the key targets,
   * as the list: these swaps are mainnet only, so a sandbox key finds none (it
   * used to read and submit its own account's mainnet swaps by id). The shared
   * public key also needs the swap's record token (`recordToken`, from
   * `X-Record-Token`); without the right one this is a miss too, decided before
   * the table is read. On a legacy route (`legacyRoute`, the submit) a missing
   * token is still admitted for now, and logged once the swap is found.
   */
  async findOwned(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
    legacyRoute?: LegacyRecordTokenRoute,
  ): Promise<ChainSwap | null> {
    if (
      !this.recordTokens.admits(
        consumer,
        'chain-swap',
        id,
        recordToken,
        legacyRoute,
      )
    ) {
      return null;
    }
    const swap = await this.prisma.chainSwap.findFirst({
      where: this.ownedWhere(consumer, id),
    });
    if (swap && legacyRoute) {
      this.recordTokens.noteLegacyAccess(
        consumer,
        'chain-swap',
        id,
        recordToken,
        legacyRoute,
      );
    }
    return swap;
  }

  /**
   * The one filter every by-id read and write of a Solana or Monad swap goes
   * through: the calling consumer AND the network its key targets, as the list
   * filters. Another network's swap is a miss, as another consumer's is.
   */
  private ownedWhere(consumer: GatewayConsumer, id: string) {
    return {
      id,
      consumer: { apisixUsername: consumer.username },
      network: resolveNetwork(this.config, consumer),
    };
  }

  present(swap: ChainSwap): PublicChainSwap {
    return project(swap, CHAIN_SWAP_PUBLIC_SELECT);
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  /**
   * Relays the signed transaction. Nothing about the swap is answered until
   * `signedTransaction` is the transaction built for it, signed by its source:
   * the venue checks the bytes, then broadcasts through this service's RPC.
   * A node refusing it is 400 `transaction_rejected` and leaves the swap
   * PENDING, so a transient refusal cannot mark it FAILED; only the chain's
   * own verdict does, through the observer.
   *
   * A Monad swap may instead send `txHash`, for a wallet that broadcasts the
   * transaction itself: see {@link submitSent}.
   */
  async submit(
    consumer: GatewayConsumer,
    swap: ChainSwap,
    signedTransaction: string | undefined,
    txHash?: string,
  ): Promise<ChainSwapSubmitOutcome> {
    if (signedTransaction !== undefined && txHash !== undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Send signedTransaction or txHash, not both',
      );
    }
    const venue = this.venues[swap.chain as OtherChain];
    if (txHash !== undefined) {
      return this.submitSent(consumer, swap, venue, txHash);
    }
    if (!signedTransaction) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        venue.verifySent
          ? `signedTransaction or txHash is required for a ${chainLabel(swap)} swap`
          : `signedTransaction is required for a ${chainLabel(swap)} swap`,
      );
    }
    // First, and before anything about the swap is answered: the transaction
    // must be the one built for it, signed by its source.
    const hash = venue.verify(swap, signedTransaction);
    if (swap.status !== 'PENDING' && swap.status !== 'SUBMITTED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Swap ${swap.id} is ${swap.status}; build a new swap.`,
      );
    }
    if (swap.status === 'PENDING' && swap.expiresAt <= new Date()) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Swap ${swap.id} expired before it was submitted; build a new swap.`,
      );
    }
    await venue.broadcast(signedTransaction);

    const { count } = await this.prisma.chainSwap.updateMany({
      where: { id: swap.id, status: 'PENDING' },
      data: { status: 'SUBMITTED', txHash: hash },
    });
    const row = await this.prisma.chainSwap.findUniqueOrThrow({
      where: { id: swap.id },
    });
    if (count === 1) {
      await this.emit(consumer.username, 'SWAP_SUBMITTED', row);
    }
    return {
      submitted: true,
      status: row.status,
      txHash: hash,
      swap: this.present(row),
    };
  }

  /**
   * Records a transaction the wallet already broadcast (Monad: a browser
   * wallet's `eth_sendTransaction` hands back only the hash). The venue reads
   * it from the chain and checks it is the call built for this swap, sent by
   * its source, before anything about the swap is answered; then the swap
   * moves as after a broadcast of ours: SUBMITTED with the hash, and the
   * observer settles it on the receipt.
   *
   * - The same hash again answers the swap as it is; a hash recorded on
   *   another swap, or a swap already submitted with another one, is refused.
   * - The two-minute validity window is not checked: it keeps this service
   *   from broadcasting a stale route, and this transaction is already on the
   *   network, where the calldata's own minimum output protects the source.
   *   Refusing it would not stop it; it would only leave the swap reading
   *   EXPIRED while it settles. So a PENDING swap past its window, or one
   *   the observer already EXPIRED before any hash was recorded, takes it.
   */
  private async submitSent(
    consumer: GatewayConsumer,
    swap: ChainSwap,
    venue: ChainSwapVenue,
    txHash: string,
  ): Promise<ChainSwapSubmitOutcome> {
    if (!venue.verifySent) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `txHash is for a Monad swap; a ${chainLabel(swap)} ` +
          'swap takes signedTransaction, the signed transaction this service broadcasts',
      );
    }
    const hash = await venue.verifySent(swap, txHash);
    if (swap.txHash === hash) {
      return {
        submitted: true,
        status: swap.status,
        txHash: hash,
        swap: this.present(swap),
      };
    }
    const elsewhere = await this.prisma.chainSwap.findFirst({
      where: { chain: swap.chain, txHash: hash },
      select: { id: true },
    });
    if (elsewhere) throw sentElsewhere(hash);
    if (swap.txHash !== null) throw submittedWith(swap);
    if (swap.status !== 'PENDING' && swap.status !== 'EXPIRED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Swap ${swap.id} is ${swap.status}; build a new swap.`,
      );
    }

    let count: number;
    try {
      ({ count } = await this.prisma.chainSwap.updateMany({
        where: {
          id: swap.id,
          status: { in: ['PENDING', 'EXPIRED'] },
          txHash: null,
        },
        data: { status: 'SUBMITTED', txHash: hash },
      }));
    } catch (err) {
      // Another swap recorded the same hash between the read and this write.
      if (isUniqueViolation(err)) throw sentElsewhere(hash);
      throw err;
    }
    const row = await this.prisma.chainSwap.findUniqueOrThrow({
      where: { id: swap.id },
    });
    if (count === 1) {
      await this.emit(consumer.username, 'SWAP_SUBMITTED', row);
    } else if (row.txHash !== hash) {
      // A concurrent submit recorded another hash first.
      throw submittedWith(row);
    }
    return {
      submitted: true,
      status: row.status,
      txHash: hash,
      swap: this.present(row),
    };
  }

  // ── Settlement (observer) ─────────────────────────────────────────────────
  /**
   * Moves a swap to where the chain says it is. A compare-and-swap on the
   * status it was read with, so only the writer that wins emits; the terminal
   * events are also deduplicated by the emitter.
   */
  async settle(
    swap: ChainSwap,
    username: string,
    next: 'SUCCEEDED' | 'FAILED' | 'EXPIRED',
  ): Promise<void> {
    const { count } = await this.prisma.chainSwap.updateMany({
      where: { id: swap.id, status: swap.status },
      data: { status: next, lastCheckedAt: new Date() },
    });
    if (count !== 1) return;
    this.logger.log(`${swap.chain} swap ${swap.id}: ${swap.status} → ${next}`);
    // EXPIRED is recorded on the row, not notified — as for Stellar swaps.
    if (next === 'EXPIRED') return;
    const row = await this.prisma.chainSwap.findUniqueOrThrow({
      where: { id: swap.id },
    });
    await this.emit(
      username,
      next === 'SUCCEEDED' ? 'SWAP_SUCCEEDED' : 'SWAP_FAILED',
      row,
    );
  }

  /** Records that the observer looked, without moving the swap. */
  async touch(id: string): Promise<void> {
    await this.prisma.chainSwap.update({
      where: { id },
      data: { lastCheckedAt: new Date() },
    });
  }

  venue(chain: OtherChain): ChainSwapVenue {
    return this.venues[chain];
  }

  // ── Pricing ───────────────────────────────────────────────────────────────
  private async price(
    consumer: GatewayConsumer,
    dto: QuoteSwapDto & Partial<CreateSwapDto>,
    sourceAssetCode: string | undefined,
  ): Promise<Priced> {
    const chain = dto.chain as OtherChain;
    if (resolveNetwork(this.config, consumer) !== 'public') {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        `Swaps on ${chain} run on mainnet only: ${
          CHAIN_SWAP_PROVIDERS[chain] === 'jupiter'
            ? 'the Solana swap route'
            : 'the Monad swap route'
        } has no test network. Use a prod API key.`,
      );
    }
    this.refuseStellarOnlyFields(chain, dto);
    const unsupported = dto.merchantFee
      ? this.venues[chain].merchantFeeUnsupported()
      : null;
    if (unsupported) {
      throw ApiError.badRequest(
        ApiErrorCode.MerchantFeeUnsupported,
        `A merchant fee is not available on ${chain} swaps on this deployment: ${unsupported}.`,
      );
    }
    if (!sourceAssetCode) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `sourceAssetCode is required on ${chain}`,
      );
    }

    const venue = this.venues[chain];
    const [send, dest] = await Promise.all([
      venue.resolveAsset(sourceAssetCode),
      venue.resolveAsset(dto.destAssetCode),
    ]);
    if (send.asset.toLowerCase() === dest.asset.toLowerCase()) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Source and destination assets must differ for a swap',
      );
    }
    const amount = this.baseUnits(dto.amount, send);
    // The merchant fee is paid in the source asset, out of the source wallet:
    // taken from `amount` (the swap routes less) or sent beside it.
    const merchant = resolveMerchantFee(
      dto.merchantFee,
      send.decimals,
      CHAIN_ADDRESS_RULES[chain],
    );
    if (
      merchant &&
      dto.source &&
      normalizeAddress(chain, dto.source) === merchant.wallet
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'merchantFee.wallet must be another account than source',
      );
    }
    const split = splitMerchantFee(amount, merchant);
    assertMerchantFeeCovered(split, merchant);
    const slippageBps = resolveSlippage(
      dto.slippageBps,
      this.config.get('stellar', { infer: true }).swap,
    );
    const feeWallet = this.config.get(chain, { infer: true }).swapFeeWallet;
    // A commission with nowhere to go is a misconfiguration, not a free swap
    // (waived only by SWAP_COMMISSION_DEV_WAIVER, outside production).
    const feeBps = commissionWithRecipient(
      this.config,
      // The fee wallet swapping its own funds pays itself nothing.
      commissionForSource(
        resolvePlanCommissionBps(this.config, consumer),
        dto.source ? normalizeAddress(chain, dto.source) : null,
        feeWallet ? normalizeAddress(chain, feeWallet) : null,
      ),
      feeWallet,
      `${chain.toUpperCase()}_SWAP_FEE_WALLET`,
    );
    return {
      chain,
      amount,
      merchantFee: merchant
        ? {
            terms: merchant,
            record: merchantFeeRecord(
              merchant,
              split.fee,
              send.decimals,
              send.asset,
            ),
          }
        : null,
      request: {
        // A quote names no wallet; building always does.
        source: dto.source ? normalizeAddress(chain, dto.source) : null,
        send,
        dest,
        amount: split.net,
        slippageBps,
        feeBps,
        feeWallet: feeBps > 0 ? feeWallet : null,
        merchantFee: merchant
          ? { wallet: merchant.wallet, amount: split.fee }
          : null,
      },
    };
  }

  /** Issuers, a memo and a separate destination only mean something on Stellar. */
  private refuseStellarOnlyFields(
    chain: OtherChain,
    dto: QuoteSwapDto & Partial<CreateSwapDto>,
  ): void {
    const stray = (
      [
        ['sourceAssetIssuer', dto.sourceAssetIssuer],
        ['destAssetIssuer', dto.destAssetIssuer],
        ['memo', dto.memo],
      ] as const
    ).find(([, value]) => value !== undefined);
    if (stray) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `${stray[0]} is Stellar only; it has no meaning on ${chain}`,
      );
    }
    if (
      dto.destination !== undefined &&
      dto.source !== undefined &&
      normalizeAddress(chain, dto.destination) !==
        normalizeAddress(chain, dto.source)
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `On ${chain} the swap output goes to source; destination must be omitted or equal it`,
      );
    }
  }

  private baseUnits(amount: string, asset: VenueAsset): bigint {
    let units: bigint;
    try {
      units = parseUnits(amount, asset.decimals);
    } catch {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `amount has more decimal places than the asset allows (${asset.decimals})`,
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

  // ── Idempotency ───────────────────────────────────────────────────────────
  private termsOf({ chain, amount, request }: Priced): ChainSwapTerms {
    return {
      chain,
      source: request.source ?? '',
      sendAsset: request.send.asset,
      sendAmount: formatUnits(amount, request.send.decimals),
      destAsset: request.dest.asset,
      slippageBps: request.slippageBps,
    };
  }

  private replay(
    existing: ChainSwap,
    terms: ChainSwapTerms,
    consumer: GatewayConsumer,
    priced: Priced,
  ): PublicChainSwap {
    // The merchant fee is compared like the source: it pays a wallet the
    // caller names.
    const same =
      (Object.keys(terms) as (keyof ChainSwapTerms)[]).every(
        (key) => existing[key] === terms[key],
      ) &&
      sameMerchantFee(
        existing.merchantFee,
        priced.merchantFee?.terms ?? null,
        priced.request.send.decimals,
      );
    if (!same) {
      this.logger.warn(
        `Idempotency-Key reused for a different swap request ` +
          `(swap=${existing.id}, consumer=${consumer.username})`,
      );
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'This Idempotency-Key was already used for a different swap request. ' +
          'Use a new key for a new request.',
      );
    }
    return this.present(existing);
  }

  private findByKey(
    consumerId: string,
    idempotencyKey: string,
  ): Promise<ChainSwap | null> {
    return this.prisma.chainSwap.findUnique({
      where: { consumerId_idempotencyKey: { consumerId, idempotencyKey } },
    });
  }

  private async persist(
    data: Prisma.ChainSwapUncheckedCreateInput,
  ): Promise<ChainSwap | null> {
    try {
      return await this.prisma.chainSwap.create({ data });
    } catch (err) {
      if (isUniqueViolation(err) && data.idempotencyKey) return null;
      throw err;
    }
  }

  /** Webhooks carry the public projection — the same SWAP_* events as Stellar. */
  private emit(
    username: string,
    type: WebhookEventType,
    swap: ChainSwap,
  ): Promise<boolean> {
    return this.webhooks.emit(username, type, this.present(swap));
  }
}

/** `Solana`, `Monad`: the chain as a message names it. */
function chainLabel(swap: ChainSwap): string {
  return swap.chain.charAt(0).toUpperCase() + swap.chain.slice(1);
}

/** A sent transaction is recorded on one swap only. */
function sentElsewhere(hash: string): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.ValidationFailed,
    `Transaction ${hash} is already recorded on another swap`,
  );
}

function submittedWith(swap: ChainSwap): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.InvalidStateTransition,
    `Swap ${swap.id} was already submitted with transaction ${swap.txHash}; ` +
      'build a new swap.',
  );
}
