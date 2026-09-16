import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolvePlanCommissionBps } from '@/common/plan-commission';
import { isUniqueViolation } from '@/common/prisma-errors';
import { resolveNetwork } from '@/common/stellar-network';
import { project } from '@/common/projection';
import { PrismaService } from '@/prisma/prisma.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { assetLabel, resolveAsset, ResolvedAsset } from '@/stellar/asset';
import { resolveMemoId } from '@/stellar/memo';
import { sep7Qr, sep7TxUri } from '@/stellar/sep7';
import { SettlementRepository } from '@/stellar/settlement.repository';
import {
  RelayProfile,
  SignedTransactionRelay,
} from '@/stellar/signed-transaction-relay.service';
import {
  resolveIdempotencyKey,
  resolveSlippage,
} from '@/stellar/stellar-operation-policy';
import { StellarService } from '@/stellar/stellar.service';
import { cannotHaveSettled } from '@/stellar/stored-envelope';
import type {
  Prisma,
  Swap,
  SwapStatus,
  WebhookEventType,
} from '@generated/prisma/client';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { CreateSwapDto } from '@/swaps/dto/create-swap.dto';
import { QuerySwapsDto } from '@/swaps/dto/query-swaps.dto';
import { QuoteSwapDto } from '@/swaps/dto/quote-swap.dto';
import {
  SWAP_CAN_SUCCEED_STATUSES,
  SWAP_IN_FLIGHT_STATUSES,
} from '@/swaps/swap-transitions';
import {
  SwapAssetAmount,
  SwapPathHop,
  SwapQuoteEntity,
} from '@/swaps/entities/swap.entity';
import {
  applySlippage,
  computeFee,
  fromStroops,
  toStroops,
} from '@/swaps/swap-math';
import { SwapRequestTerms, swapMatchesRequest } from '@/swaps/swap-idempotency';
import { SWAP_COMMISSION_MEMO } from '@/swaps/swaps.constants';

/**
 * The columns a swap may leave this service with: every field `SwapEntity`
 * documents, plus `expiresAt`. An allowlist, because the spread it replaces
 * answered with the whole row — `consumerId` and the settlement bookkeeping
 * (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`) — on routes the shared
 * public key reaches, and would have answered with any column added later. The
 * list reads through it as a `select`; the single-row paths, which need the full
 * row for the relay and the observer, cut it with {@link project}.
 */
export const SWAP_PUBLIC_SELECT = {
  id: true,
  status: true,
  network: true,
  source: true,
  destination: true,
  sendAsset: true,
  sendAssetIssuer: true,
  sendAmount: true,
  feeAmount: true,
  feeBps: true,
  swapAmount: true,
  destAsset: true,
  destAssetIssuer: true,
  destEstimated: true,
  destMin: true,
  slippageBps: true,
  path: true,
  memo: true,
  idempotencyKey: true,
  xdr: true,
  uri: true,
  txHash: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.SwapSelect;

/** A swap as the list returns it. */
export type PublicSwap = Prisma.SwapGetPayload<{
  select: typeof SWAP_PUBLIC_SELECT;
}>;

/** A public swap plus its derived QR — the shape single-swap responses return. */
export type SwapView = PublicSwap & {
  qr: string;
  /** The commission MEMO_TEXT label when a commission was collected, else null. */
  commissionMemo: string | null;
};

/**
 * Result of relaying a signed swap (the service-side counterpart of
 * SwapSubmitResultEntity, which only describes the OpenAPI shape).
 */
export interface SwapSubmitOutcome {
  submitted: boolean;
  status: SwapStatus;
  txHash?: string;
  reason?: string;
  resultCodes?: string[];
  swap: SwapView;
}

/** Resolved asset: its stored code/issuer and the SDK Asset for building txs. */
/** A priced swap — everything quote and create both need. */
interface PricedSwap {
  send: ResolvedAsset;
  dest: ResolvedAsset;
  feeBps: number;
  slippageBps: number;
  sendAmount: string; // gross input
  feeAmount: string; // taken from the source asset
  swapAmount: string; // routed (input − fee)
  estimated: string; // quoted destination amount
  destMin: string; // slippage-protected minimum
  path: SwapPathHop[];
}

/** Minimal shape we read off a Horizon path record. */
interface PathRecord {
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

/**
 * Stellar native swaps. Stellar has no swap primitive — asset exchange is a
 * `PathPaymentStrictSend` routed through the DEX/AMM. This service is
 * **non-custodial**: it quotes via Horizon, assembles the unsigned transaction
 * (an optional platform fee payment + the path payment), and relays the signed
 * transaction the customer hands back. Funds never pass through Cosmos Pay.
 */
@Injectable()
export class SwapsService {
  private readonly logger = new Logger(SwapsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly stellar: StellarService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: StellarAccountLoader,
    private readonly relay: SignedTransactionRelay,
  ) {}

  // ── Quote ───────────────────────────────────────────────────────────────────
  /** Prices a swap (Horizon path search + fee/slippage math). Persists nothing. */
  async quote(
    consumer: GatewayConsumer,
    dto: QuoteSwapDto,
  ): Promise<SwapQuoteEntity> {
    const network = this.resolveNetwork(consumer);
    const priced = await this.priceSwap(
      network,
      dto,
      resolvePlanCommissionBps(this.config, consumer),
    );
    return this.toQuoteEntity(network, priced);
  }

  // ── Create ────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned swap transaction and persists it. Returns the XDR + a
   * SEP-7 `tx` URI + QR for the customer's wallet to sign, then submitted back
   * via {@link submit}.
   *
   * Idempotency: pass `Idempotency-Key` (header) or `idempotencyKey` (body). The
   * same key for a consumer, sent with the same request, returns the existing
   * swap instead of building another transaction (and never mints a second
   * `SWAP_CREATED`); the same key with a different request is a 409
   * `idempotency_conflict` — see {@link replay}. Without a key, the unique
   * `(network, txHash)` constraint still rejects a byte-identical rebuild with
   * 409. Optional `STELLAR_SWAP_SINGLE_INFLIGHT=true` rejects a second
   * non-expired PENDING swap for the same `(consumer, source, network)` with 409
   * — but only one that may already have settled; see
   * {@link assertNoInflightSwap}.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateSwapDto,
    headerIdempotencyKey?: string,
  ): Promise<SwapView> {
    const network = this.resolveNetwork(consumer);
    const local = await this.resolveConsumer(consumer);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );
    const memo = resolveMemoId(dto.memo);
    const terms = this.requestTerms(network, dto, memo);

    // Fast path: same key and same request → same swap (no Horizon round-trip).
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) return this.replay(existing, terms, consumer);
    }

    const priced = await this.priceSwap(
      network,
      dto,
      resolvePlanCommissionBps(this.config, consumer),
    );

    const destination = terms.destination;
    const feeWallet = this.feeWallet();
    const feeStroops = toStroops(priced.feeAmount);

    // A configured fee with nowhere to send it is a misconfiguration, not a
    // silent no-op — fail loudly so the operator notices.
    if (feeStroops > 0n && !feeWallet) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'A swap fee is configured (STELLAR_SWAP_FEE_BPS) but STELLAR_SWAP_FEE_WALLET is not set',
      );
    }

    const stellarCfg = this.config.get('stellar', { infer: true });
    const account = await this.accounts.load(network, dto.source);
    // Read the sequence before anything builds from `account`:
    // `TransactionBuilder.build()` advances it in place.
    await this.assertNoInflightSwap(
      local.id,
      dto.source,
      network,
      account.sequenceNumber(),
    );

    // The destination must already trust a non-native asset, or the path payment
    // would fail on-chain. Catch it now with a clear message.
    await this.assertDestinationCanReceive(network, destination, priced.dest, {
      account,
      address: dto.source,
    });

    const builder = new TransactionBuilder(account, {
      fee: stellarCfg.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    });
    // Operation 1: collect the platform fee in the source asset (skipped at 0%).
    if (feeStroops > 0n && feeWallet) {
      builder.addOperation(
        Operation.payment({
          destination: feeWallet,
          asset: priced.send.asset,
          amount: priced.feeAmount,
        }),
      );
    }
    // Operation 2: the swap itself — send the net amount, receive ≥ destMin.
    builder.addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: priced.send.asset,
        sendAmount: priced.swapAmount,
        destination,
        destAsset: priced.dest.asset,
        destMin: priced.destMin,
        path: this.pathToAssets(priced.path),
      }),
    );
    // Caller MEMO_ID when supplied; otherwise a default commission MEMO_TEXT so
    // the platform fee is identifiable on-chain. No memo when neither applies.
    if (memo) {
      builder.addMemo(Memo.id(memo));
    } else if (feeStroops > 0n) {
      builder.addMemo(Memo.text(SWAP_COMMISSION_MEMO));
    }

    const tx = builder.setTimeout(stellarCfg.timeoutSeconds).build();
    const xdr = tx.toXDR();
    const txHash = Buffer.from(tx.hash()).toString('hex');
    const uri = sep7TxUri(xdr);

    const swap = await this.persistSwap({
      consumerId: local.id,
      network,
      source: dto.source,
      destination,
      sendAsset: priced.send.code,
      sendAssetIssuer: priced.send.issuer,
      sendAmount: priced.sendAmount,
      feeAmount: priced.feeAmount,
      feeBps: priced.feeBps,
      swapAmount: priced.swapAmount,
      destAsset: priced.dest.code,
      destAssetIssuer: priced.dest.issuer,
      destEstimated: priced.estimated,
      destMin: priced.destMin,
      slippageBps: priced.slippageBps,
      path: priced.path as unknown as Prisma.InputJsonValue,
      memo,
      idempotencyKey,
      status: 'PENDING',
      xdr,
      uri,
      txHash,
      // The tx is only valid for its timeout window; after that it can't settle.
      expiresAt: new Date(Date.now() + stellarCfg.timeoutSeconds * 1000),
    });

    // Race: another request with the same key won the insert — return theirs,
    // provided it was the same request.
    if (!swap) {
      const raced = await this.findByIdempotencyKey(local.id, idempotencyKey!);
      if (raced) return this.replay(raced, terms, consumer);
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A swap with this transaction hash already exists for this network. ' +
          'Retry with an Idempotency-Key, or wait for the prior swap to settle/expire.',
      );
    }

    this.logger.log(
      `Created swap ${swap.id}: ${priced.sendAmount} ${assetLabel(priced.send)} → ` +
        `~${priced.estimated} ${assetLabel(priced.dest)} (consumer=${consumer.username}, network=${network})`,
    );
    await this.emit(consumer.username, 'SWAP_CREATED', swap);
    return this.withQr(swap);
  }

  /**
   * Persists a new swap. Returns null on an idempotency-key unique violation so
   * the caller can fall back to the existing row. A `(network, txHash)` collision
   * without a recoverable idempotency key throws a 409 `idempotency_conflict`.
   */
  private async persistSwap(
    data: Prisma.SwapUncheckedCreateInput,
  ): Promise<Swap | null> {
    try {
      return await this.prisma.swap.create({ data });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // With a key, always let the caller recover the existing row: a same-key
      // race can trip the (network, txHash) index instead of the key index
      // (Postgres reports only one of the two violations arbitrarily).
      if (data.idempotencyKey) return null;
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A swap with this transaction hash already exists for this network. ' +
          'Two creates rebuilt the same Stellar sequence/XDR — use an ' +
          'Idempotency-Key on retries, or wait for the prior swap to settle/expire.',
      );
    }
  }

  /**
   * The request as a stored row would record it, so a replay can be compared
   * field by field. Applies the same defaults `create` does — destination falls
   * back to the source, slippage to the configured default — because a retry
   * that leaves them out is asking for the same swap.
   */
  private requestTerms(
    network: StellarNetwork,
    dto: CreateSwapDto,
    memo: string | null,
  ): SwapRequestTerms {
    const send = resolveAsset(dto.sourceAssetCode, dto.sourceAssetIssuer);
    const dest = resolveAsset(dto.destAssetCode, dto.destAssetIssuer);
    return {
      network,
      source: dto.source,
      destination: dto.destination ?? dto.source,
      sendAsset: send.code,
      sendAssetIssuer: send.issuer,
      sendAmount: dto.amount,
      destAsset: dest.code,
      destAssetIssuer: dest.issuer,
      slippageBps: resolveSlippage(
        dto.slippageBps,
        this.config.get('stellar', { infer: true }).swap,
      ),
      memo,
    };
  }

  /**
   * Answers a request that reused an `Idempotency-Key`: the stored swap when it
   * is the same request, a 409 when it is not.
   *
   * A key is scoped to the consumer, and every anonymous wallet on the shared
   * public API key is the same consumer — so "same consumer" never meant "same
   * caller". Returning the stored row unconditionally handed one caller's
   * envelope to anyone who later sent the key, including a transfer to the
   * first caller that the second would then sign. The conflict describes nothing
   * about the stored swap, because whoever is asking may not be who created it.
   */
  private async replay(
    existing: Swap,
    request: SwapRequestTerms,
    consumer: GatewayConsumer,
  ): Promise<SwapView> {
    if (!swapMatchesRequest(existing, request)) {
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
    return this.withQr(existing);
  }

  private async findByIdempotencyKey(
    consumerId: string,
    idempotencyKey: string,
  ): Promise<Swap | null> {
    return this.prisma.swap.findUnique({
      where: {
        consumerId_idempotencyKey: { consumerId, idempotencyKey },
      },
    });
  }

  /**
   * Optional guard (`STELLAR_SWAP_SINGLE_INFLIGHT`): at most one non-expired
   * PENDING swap per (consumer, source, network) that may already be on-chain.
   * Off by default.
   *
   * **Only a row that may already have settled holds the guard**, which is
   * {@link cannotHaveSettled}'s question and the reason it exists: `source` is a
   * public Stellar address and nothing requires the caller to control it, so a
   * merely-built row is otherwise a way to hand a stranger a 409 for a whole
   * transaction-timeout window. Consumer scoping does not close that under the
   * shared public key, where every anonymous wallet is one consumer — one dust
   * swap naming someone's account froze swapping for it, again and again. The
   * twin in `liquidity-pools.service.ts` asks the same question, and documents
   * the residual: a row built before the account's latest transaction does block
   * until it expires, because from here it looks like one that settled.
   *
   * A row whose envelope cannot be read blocks: nothing about it can be vouched
   * for. The message names the blocking row's id — both rows are the same
   * consumer's, so that discloses nothing the caller may not see.
   */
  private async assertNoInflightSwap(
    consumerId: string,
    source: string,
    network: StellarNetwork,
    accountSequence: string,
  ): Promise<void> {
    const { singleInflight } = this.config.get('stellar', {
      infer: true,
    }).swap;
    if (!singleInflight) return;

    const existing = await this.prisma.swap.findFirst({
      where: {
        consumerId,
        source,
        network,
        status: 'PENDING',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, xdr: true },
    });
    if (!existing) return;
    if (
      cannotHaveSettled(
        existing.xdr,
        this.stellar.passphrase(network),
        accountSequence,
      )
    ) {
      return;
    }
    throw ApiError.conflict(
      ApiErrorCode.OperationInFlight,
      `An in-flight swap already exists for this source account (id=${existing.id}). ` +
        'Wait for it to settle/expire, or disable STELLAR_SWAP_SINGLE_INFLIGHT.',
    );
  }

  // ── Read (list) ─────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    query: QuerySwapsDto,
  ): Promise<{
    data: PublicSwap[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      ...(query.status ? { status: query.status } : {}),
    };
    // `Promise.all`, not `$transaction` — see `@/common/pagination` for why.
    const [data, total] = await Promise.all([
      this.prisma.swap.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: SWAP_PUBLIC_SELECT,
      }),
      this.prisma.swap.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  // ── Read (one) ──────────────────────────────────────────────────────────────
  async findOne(consumer: GatewayConsumer, id: string): Promise<SwapView> {
    const swap = await this.findOwned(consumer, id);
    return this.withQr(swap);
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  /**
   * Relays the signed transaction to the network. The signed envelope must be the
   * one we built (its hash is verified against the stored swap), so a caller can't
   * have us broadcast an arbitrary transaction. A network rejection finalizes the
   * swap as FAILED (with the result codes); an unreachable network is a 503 and
   * leaves the swap re-submittable.
   *
   * The mechanics are {@link SignedTransactionRelay}'s, shared with liquidity
   * pools; this supplies the swap table, its events and its response shape.
   */
  async submit(
    consumer: GatewayConsumer,
    id: string,
    signedXdr: string,
  ): Promise<SwapSubmitOutcome> {
    const swap = await this.findOwned(consumer, id);
    const { view, ...outcome } = await this.relay.submit(
      swap,
      consumer.username,
      signedXdr,
      this.submission,
    );
    return { ...outcome, swap: view };
  }

  /** What relaying differs in for this table; see {@link submit}. */
  private get submission(): RelayProfile<Swap, SwapView> {
    return {
      settlement: this.settlement,
      submittedEvent: 'SWAP_SUBMITTED',
      emit: (username, type, swap) => this.emit(username, type, swap),
      present: (swap) => this.withQr(swap),
      labels: { resource: 'swap', match: 'swap', log: 'Swap' },
      logger: this.logger,
    };
  }

  // ── Pricing ──────────────────────────────────────────────────────────────
  private async priceSwap(
    network: StellarNetwork,
    dto: QuoteSwapDto,
    feeBps: number,
  ): Promise<PricedSwap> {
    const send = resolveAsset(dto.sourceAssetCode, dto.sourceAssetIssuer);
    const dest = resolveAsset(dto.destAssetCode, dto.destAssetIssuer);
    if (send.code === dest.code && send.issuer === dest.issuer) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Source and destination assets must differ for a swap',
      );
    }

    const slippageBps = resolveSlippage(
      dto.slippageBps,
      this.config.get('stellar', { infer: true }).swap,
    );
    const sendStroops = toStroops(dto.amount);
    const feeStroops = computeFee(sendStroops, feeBps);
    const swapStroops = sendStroops - feeStroops;
    if (swapStroops <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'amount is too small to cover the swap fee',
      );
    }
    const swapAmount = fromStroops(swapStroops);

    const best = await this.findBestPath(network, send, swapAmount, dest);
    const estStroops = toStroops(best.destination_amount);
    const destMinStroops = applySlippage(estStroops, slippageBps);

    return {
      send,
      dest,
      feeBps,
      slippageBps,
      sendAmount: fromStroops(sendStroops),
      feeAmount: fromStroops(feeStroops),
      swapAmount,
      estimated: fromStroops(estStroops),
      destMin: fromStroops(destMinStroops),
      path: best.path.map((p) =>
        p.asset_type === 'native'
          ? { code: 'native', issuer: null }
          : { code: p.asset_code ?? '', issuer: p.asset_issuer ?? null },
      ),
    };
  }

  private async findBestPath(
    network: StellarNetwork,
    send: ResolvedAsset,
    swapAmount: string,
    dest: ResolvedAsset,
  ): Promise<PathRecord> {
    let records: PathRecord[];
    try {
      const page = await this.stellar
        .server(network)
        .strictSendPaths(send.asset, swapAmount, [dest.asset])
        .call();
      records = page.records;
    } catch (err) {
      this.logger.error('strictSendPaths failed', err);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not reach the Stellar network for a quote',
      );
    }
    if (!records.length) {
      throw ApiError.badRequest(
        ApiErrorCode.NoPathFound,
        'No swap path found for this asset pair and amount',
      );
    }
    // Best price = the most destination asset for our fixed send amount.
    return records.reduce((best, r) =>
      toStroops(r.destination_amount) > toStroops(best.destination_amount)
        ? r
        : best,
    );
  }

  private toQuoteEntity(
    network: StellarNetwork,
    priced: PricedSwap,
  ): SwapQuoteEntity {
    const sideOf = (a: ResolvedAsset, amount: string): SwapAssetAmount => ({
      asset: a.code,
      issuer: a.issuer,
      amount,
    });
    return {
      network,
      source: sideOf(priced.send, priced.sendAmount),
      fee: {
        asset: priced.send.code,
        issuer: priced.send.issuer,
        amount: priced.feeAmount,
        bps: priced.feeBps,
        wallet: this.feeWallet() || null,
        label: SWAP_COMMISSION_MEMO,
      },
      swap: sideOf(priced.send, priced.swapAmount),
      destination: {
        asset: priced.dest.code,
        issuer: priced.dest.issuer,
        estimated: priced.estimated,
        minimum: priced.destMin,
        slippageBps: priced.slippageBps,
      },
      path: priced.path,
    };
  }

  // ── Status transitions ──────────────────────────────────────────────────────
  /**
   * The compare-and-swap settlement machine, shared with liquidity pools.
   * Winning its write is what authorizes a terminal webhook — arriving at
   * SUCCEEDED/FAILED by a stale read must not emit.
   *
   * Built lazily rather than injected because it closes over `this.emit` and the
   * swap-specific status sets — it is a configured view of this service's own
   * table, not a collaborator with a lifecycle of its own.
   */
  private get settlement(): SettlementRepository<Swap> {
    this.settlementRepo ??= new SettlementRepository<Swap>(
      this.prisma.swap,
      SWAP_CAN_SUCCEED_STATUSES,
      SWAP_IN_FLIGHT_STATUSES,
      { succeeded: 'SWAP_SUCCEEDED', failed: 'SWAP_FAILED' },
      (username, type, swap) => this.emit(username, type, swap),
    );
    return this.settlementRepo;
  }
  private settlementRepo?: SettlementRepository<Swap>;

  /**
   * Promotes an in-flight (or falsely-FAILED) swap to SUCCEEDED. Idempotent if
   * already SUCCEEDED. Used by submit and the settlement observer so both
   * writers share the same guard and the same emit function.
   */
  async finalizeSucceeded(
    id: string,
    username: string,
    txHash?: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, row } = await this.settlement.finalizeSucceeded(
      id,
      username,
      txHash,
    );
    return { applied, swap: row };
  }

  /**
   * Same status transition as {@link finalizeSucceeded} but never emits a
   * webhook. Used by the observer for historical duplicate-hash rows so one
   * on-chain tx yields a single `SWAP_SUCCEEDED`.
   */
  async finalizeSucceededQuiet(
    id: string,
    txHash?: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, row } = await this.settlement.finalizeSucceededQuiet(
      id,
      txHash,
    );
    return { applied, swap: row };
  }

  /**
   * Marks FAILED only while the row is still in-flight. A settled
   * (`SUCCEEDED`) swap is left untouched.
   */
  async finalizeFailed(
    id: string,
    username: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, row } = await this.settlement.finalizeFailed(id, username);
    return { applied, swap: row };
  }

  /**
   * Same status transition as {@link finalizeFailed} without a webhook — for
   * duplicate-hash phantom rows in the observer.
   */
  async finalizeFailedQuiet(
    id: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, row } = await this.settlement.finalizeFailedQuiet(id);
    return { applied, swap: row };
  }

  /**
   * Marks EXPIRED only while the row is still in-flight. Never degrades a
   * settled swap.
   */
  async finalizeExpired(id: string): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, row } = await this.settlement.finalizeExpired(id);
    return { applied, swap: row };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** Network follows the API key type (prod → public, dev → testnet). */
  private resolveNetwork(consumer: GatewayConsumer): StellarNetwork {
    return resolveNetwork(this.config, consumer);
  }

  /** Mirror the APISIX consumer locally so swaps can be scoped to it. */
  private resolveConsumer(consumer: GatewayConsumer) {
    return this.consumers.resolve(consumer);
  }

  private feeWallet(): string {
    return this.config.get('stellar', { infer: true }).swap.feeWallet;
  }

  private pathToAssets(path: SwapPathHop[]): Asset[] {
    return path.map((h) =>
      h.issuer ? new Asset(h.code, h.issuer) : Asset.native(),
    );
  }

  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<Swap> {
    const swap = await this.prisma.swap.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!swap) {
      throw ApiError.notFound(`Swap ${id} not found`);
    }
    return swap;
  }

  /**
   * Ensures the destination can receive a non-native asset (has a trustline).
   * Native XLM needs none. Reuses the already-loaded source account when the
   * destination is the source (a self-swap).
   */
  private async assertDestinationCanReceive(
    network: StellarNetwork,
    destination: string,
    dest: ResolvedAsset,
    source: { account: { balances: unknown[] }; address: string },
  ): Promise<void> {
    if (dest.code === 'native' || !dest.issuer) return;
    const balances =
      destination === source.address
        ? source.account.balances
        : (await this.accounts.load(network, destination)).balances;
    const trusts = (balances as Array<Record<string, unknown>>).some(
      (b) => b.asset_code === dest.code && b.asset_issuer === dest.issuer,
    );
    if (!trusts) {
      throw ApiError.badRequest(
        ApiErrorCode.TrustlineMissing,
        `Destination ${destination} has no trustline for ${dest.code}:${dest.issuer} — ` +
          'it must trust the asset before it can receive the swap',
      );
    }
  }

  /** A stored swap with its SEP-7 QR and commission label attached. */
  private async withQr(swap: Swap): Promise<SwapView> {
    return {
      ...project(swap, SWAP_PUBLIC_SELECT),
      qr: await sep7Qr(swap.uri),
      // A collected commission (feeAmount > 0) with no caller memo is labelled
      // on-chain with the commission memo text.
      commissionMemo:
        toStroops(swap.feeAmount) > 0n && !swap.memo
          ? SWAP_COMMISSION_MEMO
          : null,
    };
  }

  private emit(
    username: string,
    type: WebhookEventType,
    data: Swap,
  ): Promise<boolean> {
    return this.webhooks.emit(username, type, data);
  }
}
