import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ChainSwap,
  Prisma,
  SwapStatus,
  WebhookEventType,
} from '@generated/prisma/client';
import { normalizeAddress } from '@/chains/chain-address';
import type { OtherChain } from '@/chains/chains.constants';
import { formatUnits, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolvePlanCommissionBps } from '@/common/plan-commission';
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
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
    const sendAmount = formatUnits(priced.request.amount, send.decimals);
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
      // The whole input is routed: the commission comes out of the output.
      swap: { asset: send.asset, issuer: null, amount: sendAmount },
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
   */
  async create(
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
      if (existing) return this.replay(existing, terms, consumer);
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
      if (raced) return this.replay(raced, terms, consumer);
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
   * is the one a miss has always answered.
   */
  findOwned(consumer: GatewayConsumer, id: string): Promise<ChainSwap | null> {
    return this.prisma.chainSwap.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
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
   */
  async submit(
    consumer: GatewayConsumer,
    swap: ChainSwap,
    signedTransaction: string | undefined,
  ): Promise<ChainSwapSubmitOutcome> {
    if (!signedTransaction) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'signedTransaction is required for a Solana or Monad swap',
      );
    }
    const venue = this.venues[swap.chain as OtherChain];
    // First, and before anything about the swap is answered: the transaction
    // must be the one built for it, signed by its source.
    const txHash = venue.verify(swap, signedTransaction);
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
      data: { status: 'SUBMITTED', txHash },
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
      txHash,
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
        `Swaps on ${chain} run on mainnet only — ${
          CHAIN_SWAP_PROVIDERS[chain] === 'jupiter' ? 'Jupiter' : 'Kuru Flow'
        } has no test network. Use a prod API key.`,
      );
    }
    this.refuseStellarOnlyFields(chain, dto);
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
    const slippageBps = resolveSlippage(
      dto.slippageBps,
      this.config.get('stellar', { infer: true }).swap,
    );
    const feeBps = resolvePlanCommissionBps(this.config, consumer);
    const feeWallet = this.config.get(chain, { infer: true }).swapFeeWallet;
    // A commission with nowhere to go is a misconfiguration, not a free swap.
    if (feeBps > 0 && !feeWallet) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `A swap commission applies to this plan but ${chain.toUpperCase()}_SWAP_FEE_WALLET is not set`,
      );
    }
    return {
      chain,
      request: {
        // A quote names no wallet; building always does.
        source: dto.source ? normalizeAddress(chain, dto.source) : null,
        send,
        dest,
        amount,
        slippageBps,
        feeBps,
        feeWallet: feeBps > 0 ? feeWallet : null,
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
  private termsOf({ chain, request }: Priced): ChainSwapTerms {
    return {
      chain,
      source: request.source ?? '',
      sendAsset: request.send.asset,
      sendAmount: formatUnits(request.amount, request.send.decimals),
      destAsset: request.dest.asset,
      slippageBps: request.slippageBps,
    };
  }

  private replay(
    existing: ChainSwap,
    terms: ChainSwapTerms,
    consumer: GatewayConsumer,
  ): PublicChainSwap {
    const same = (Object.keys(terms) as (keyof ChainSwapTerms)[]).every(
      (key) => existing[key] === terms[key],
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
