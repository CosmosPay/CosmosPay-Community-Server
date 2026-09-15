import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  FeeBumpTransaction,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolvePlanCommissionBps } from '@/common/plan-commission';
import { isUniqueViolation } from '@/common/prisma-errors';
import { resolveNetwork } from '@/common/stellar-network';
import { PrismaService } from '@/prisma/prisma.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import type { BalanceEntry } from '@/stellar/account-loader.service';
import { assetLabel, resolveAsset } from '@/stellar/asset';
import { applyMemo, resolveMemoId } from '@/stellar/memo';
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
import type {
  LiquidityPoolOperation,
  SwapStatus,
  WebhookEventType,
} from '@generated/prisma/client';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { applySlippage, fromStroops, toStroops } from '@/swaps/swap-math';
import {
  computeWithdrawCommission,
  matchDeposit,
  priceBounds,
  proportionalShare,
} from '@/liquidity-pools/lp-math';
import {
  LiquidityRequestTerms,
  liquidityOperationMatchesRequest,
} from '@/liquidity-pools/lp-idempotency';
import {
  LP_CAN_SUCCEED_STATUSES,
  LP_IN_FLIGHT_STATUSES,
} from '@/liquidity-pools/lp-operation-transitions';
import { DepositLiquidityDto } from '@/liquidity-pools/dto/deposit-liquidity.dto';
import { QueryLiquidityOperationsDto } from '@/liquidity-pools/dto/query-liquidity-operations.dto';
import { WithdrawLiquidityDto } from '@/liquidity-pools/dto/withdraw-liquidity.dto';
import { LiquidityPoolReserve } from '@/liquidity-pools/entities/liquidity-pool.entity';
import {
  LiquidityPoolReaderService,
  parseReserve,
  reserveOf,
} from '@/liquidity-pools/liquidity-pool-reader.service';
import { LpCostBasisService } from '@/liquidity-pools/lp-cost-basis.service';
import { LIQUIDITY_COMMISSION_MEMO } from '@/liquidity-pools/liquidity-pools.constants';

/** A stored operation plus its derived QR — the shape API responses return. */
export type LiquidityOperationView = LiquidityPoolOperation & {
  qr: string;
  /** The commission MEMO_TEXT label when a commission was collected, else null. */
  commissionMemo: string | null;
};

/** Result of relaying a signed liquidity pool operation. */
export interface LiquiditySubmitOutcome {
  submitted: boolean;
  status: SwapStatus;
  txHash?: string;
  reason?: string;
  resultCodes?: string[];
  operation: LiquidityOperationView;
}

/**
 * Stellar AMM liquidity pools. Like swaps, this is **non-custodial**: the
 * service prices a deposit/withdraw against the pool's on-chain reserves,
 * assembles the unsigned transaction (a pool-share `changeTrust` when needed +
 * `liquidityPoolDeposit`/`liquidityPoolWithdraw`), and relays the signed
 * envelope the customer hands back. Funds never pass through Cosmos Pay.
 *
 * This service owns the operation rows and the envelopes built into them. Pool
 * reads are {@link LiquidityPoolReaderService}'s, the cost basis withdraw
 * commission is charged against is {@link LpCostBasisService}'s, and the
 * mechanics of relaying a signed envelope are shared with swaps in
 * {@link SignedTransactionRelay}.
 */
@Injectable()
export class LiquidityPoolsService {
  private readonly logger = new Logger(LiquidityPoolsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly stellar: StellarService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: StellarAccountLoader,
    private readonly pools: LiquidityPoolReaderService,
    private readonly basis: LpCostBasisService,
    private readonly relay: SignedTransactionRelay,
  ) {}

  // ── Deposit ─────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned deposit transaction and persists it. The pair is
   * canonically ordered (assetA < assetB), amounts follow their assets, and the
   * price bounds come from the pool's current reserves (or, for a new/empty
   * pool, from the deposit's own ratio) bracketed by the slippage tolerance.
   *
   * Idempotency: pass `Idempotency-Key` (header) or `idempotencyKey` (body). The
   * same key for a consumer returns the existing operation instead of building
   * another transaction (and never mints a second `LIQUIDITY_CREATED`). Without
   * a key, the unique `(network, txHash)` constraint still rejects a
   * byte-identical rebuild with 409 — a double-submitted deposit used to leave
   * two PENDING rows sharing one on-chain transaction.
   */
  async deposit(
    consumer: GatewayConsumer,
    dto: DepositLiquidityDto,
    headerIdempotencyKey?: string,
  ): Promise<LiquidityOperationView> {
    const network = this.resolveNetwork(consumer);
    const local = await this.resolveConsumer(consumer);
    const slippageBps = resolveSlippage(
      dto.slippageBps,
      this.config.get('stellar', { infer: true }).swap,
    );
    const memo = resolveMemoId(dto.memo);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );

    // Canonical order: the protocol requires assetA < assetB. Reorder the pair
    // (and its amounts) if the caller passed them the other way around. This
    // precedes the idempotency replay, which compares against a stored row that
    // is already in canonical order.
    let a = resolveAsset(dto.assetACode, dto.assetAIssuer);
    let b = resolveAsset(dto.assetBCode, dto.assetBIssuer);
    let rawAmountA: string | undefined = dto.maxAmountA;
    let rawAmountB: string | undefined = dto.maxAmountB;
    const cmp = Asset.compare(a.asset, b.asset);
    if (cmp === 0) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'A pool needs two different assets',
      );
    }
    if (cmp > 0) {
      [a, b] = [b, a];
      [rawAmountA, rawAmountB] = [rawAmountB, rawAmountA];
    }

    const poolShare = new LiquidityPoolAsset(
      a.asset,
      b.asset,
      LiquidityPoolFeeV18,
    );
    const poolId = Buffer.from(
      getLiquidityPoolId(
        'constant_product',
        poolShare.getLiquidityPoolParameters(),
      ),
    ).toString('hex');

    const request: LiquidityRequestTerms = {
      kind: 'DEPOSIT',
      network,
      source: dto.source,
      poolId,
      assetA: a.code,
      assetAIssuer: a.issuer,
      assetB: b.code,
      assetBIssuer: b.issuer,
      amountA: rawAmountA ?? null,
      amountB: rawAmountB ?? null,
      slippageBps,
      memo,
    };

    // Fast path: same key and same request → same operation (no Horizon
    // round-trip, no rebuild).
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) return this.replay(existing, request, consumer);
    }

    const pool = await this.pools.fetchPool(network, poolId);
    const reserveA = pool ? toStroops(reserveOf(pool, a)) : 0n;
    const reserveB = pool ? toStroops(reserveOf(pool, b)) : 0n;
    const funded = reserveA > 0n && reserveB > 0n;

    // Fill in the side the caller left out from the pool's current ratio.
    let amountA = rawAmountA !== undefined ? toStroops(rawAmountA) : 0n;
    let amountB = rawAmountB !== undefined ? toStroops(rawAmountB) : 0n;
    if (funded) {
      if (rawAmountA === undefined && rawAmountB !== undefined) {
        amountA = matchDeposit(amountB, reserveB, reserveA);
      } else if (rawAmountB === undefined && rawAmountA !== undefined) {
        amountB = matchDeposit(amountA, reserveA, reserveB);
      }
    } else if (rawAmountA === undefined || rawAmountB === undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This pool has no reserves yet — provide both amounts; the deposit sets the initial price',
      );
    }
    if (amountA <= 0n || amountB <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'Deposit amounts must be greater than zero',
      );
    }

    // Deposits carry NO commission — the plan fee is charged only on the *gain*
    // at withdraw time, never on the principal. The full amounts enter the pool.

    // Price bounds around the pool price (or the deposit's own ratio when the
    // pool is empty). The deposit fails on-chain if the price drifts outside.
    let bounds: { minPrice: string; maxPrice: string };
    try {
      bounds = funded
        ? priceBounds(reserveA, reserveB, slippageBps)
        : priceBounds(amountA, amountB, slippageBps);
    } catch (err) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        (err as Error).message,
      );
    }

    const account = await this.accounts.load(network, dto.source);
    const balances = account.balances as BalanceEntry[];
    const trustContext = 'depositing it into a pool';
    this.accounts.assertTrustline(balances, a, dto.source, trustContext);
    this.accounts.assertTrustline(balances, b, dto.source, trustContext);
    const hasPoolTrust = balances.some(
      (bal) =>
        bal.asset_type === 'liquidity_pool_shares' &&
        bal.liquidity_pool_id === poolId,
    );

    const stellarCfg = this.config.get('stellar', { infer: true });

    // Pre-flight: the account must hold the full amount of each asset and keep
    // its XLM minimum reserve (incl. the new pool-share trustline) plus the tx
    // fee. Fail here with a clear 400 rather than let the network reject the
    // signed tx with op_underfunded.
    const opCount = (hasPoolTrust ? 0 : 1) + 1;
    this.accounts.assertCanAfford(
      account,
      balances,
      [
        { asset: a, required: amountA },
        { asset: b, required: amountB },
      ],
      !hasPoolTrust,
      BigInt(stellarCfg.baseFee) * BigInt(opCount),
    );

    const builder = new TransactionBuilder(account, {
      fee: stellarCfg.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    });
    // Operation 1: trust the pool share asset (first deposit into this pool).
    if (!hasPoolTrust) {
      builder.addOperation(Operation.changeTrust({ asset: poolShare }));
    }
    // Operation 2: the deposit itself, capped by the amounts + price bounds.
    builder.addOperation(
      Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId,
        maxAmountA: fromStroops(amountA),
        maxAmountB: fromStroops(amountB),
        minPrice: bounds.minPrice,
        maxPrice: bounds.maxPrice,
      }),
    );
    if (memo) builder.addMemo(Memo.id(memo));

    const tx = builder.setTimeout(stellarCfg.timeoutSeconds).build();
    const op = await this.persist(consumer, {
      consumerId: local.id,
      kind: 'DEPOSIT' as const,
      network,
      source: dto.source,
      poolId,
      assetA: a.code,
      assetAIssuer: a.issuer,
      assetB: b.code,
      assetBIssuer: b.issuer,
      amountA: fromStroops(amountA),
      amountB: fromStroops(amountB),
      shares: null,
      minPrice: bounds.minPrice,
      maxPrice: bounds.maxPrice,
      slippageBps,
      memo,
      idempotencyKey,
      // Deposits carry no commission; the cost basis is captured at settlement.
      feeBps: 0,
      feeAmountA: '0',
      feeAmountB: '0',
      feeWallet: null,
      tx,
      timeoutSeconds: stellarCfg.timeoutSeconds,
      request,
    });
    this.logger.log(
      `Created LP deposit ${op.id}: ${fromStroops(amountA)} ${assetLabel(a)} + ` +
        `${fromStroops(amountB)} ${assetLabel(b)} → pool ${poolId.slice(0, 8)}… ` +
        `(consumer=${consumer.username}, network=${network})`,
    );
    return op;
  }

  // ── Withdraw ────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned withdrawal transaction: burn `shares` pool shares for
   * the proportional amounts of both reserves, with slippage-protected on-chain
   * minimums derived from the current reserves.
   *
   * Idempotency works as on {@link deposit}. In addition, a withdrawal is
   * serialized per `(source, poolId, network)` — see
   * {@link assertNoInflightWithdraw} — because the commission depends on a cost
   * basis that only moves when an operation settles.
   */
  async withdraw(
    consumer: GatewayConsumer,
    dto: WithdrawLiquidityDto,
    headerIdempotencyKey?: string,
  ): Promise<LiquidityOperationView> {
    const network = this.resolveNetwork(consumer);
    const local = await this.resolveConsumer(consumer);
    const slippageBps = resolveSlippage(
      dto.slippageBps,
      this.config.get('stellar', { infer: true }).swap,
    );
    const memo = resolveMemoId(dto.memo);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );

    const request: LiquidityRequestTerms = {
      kind: 'WITHDRAW',
      network,
      source: dto.source,
      poolId: dto.poolId,
      shares: dto.shares,
      slippageBps,
      memo,
    };

    // Fast path: same key and same request → same operation (no Horizon
    // round-trip, no rebuild).
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) return this.replay(existing, request, consumer);
    }

    const pool = await this.pools.fetchPool(network, dto.poolId);
    if (!pool) {
      throw ApiError.badRequest(
        ApiErrorCode.NotFound,
        `Liquidity pool ${dto.poolId} not found on the ${network} network`,
      );
    }
    const total = toStroops(pool.total_shares);
    const shares = toStroops(dto.shares);
    if (shares <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'shares must be greater than zero',
      );
    }
    if (total <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This pool has no outstanding shares',
      );
    }

    const account = await this.accounts.load(network, dto.source);
    // Read the sequence before anything builds from `account`:
    // `TransactionBuilder.build()` advances it in place.
    await this.assertNoInflightWithdraw(
      local.id,
      dto.source,
      dto.poolId,
      network,
      account.sequenceNumber(),
    );
    const held = (account.balances as BalanceEntry[]).find(
      (bal) =>
        bal.asset_type === 'liquidity_pool_shares' &&
        bal.liquidity_pool_id === dto.poolId,
    );
    if (!held) {
      throw ApiError.badRequest(
        ApiErrorCode.InsufficientBalance,
        `Account ${dto.source} holds no shares of pool ${dto.poolId}`,
      );
    }
    if (toStroops(held.balance ?? '0') < shares) {
      throw ApiError.badRequest(
        ApiErrorCode.InsufficientBalance,
        `Account ${dto.source} holds only ${held.balance} shares of this pool`,
      );
    }

    const [resA, resB] = pool.reserves.map((r) => parseReserve(r));
    const minA = applySlippage(
      proportionalShare(shares, total, toStroops(resA.amount)),
      slippageBps,
    );
    const minB = applySlippage(
      proportionalShare(shares, total, toStroops(resB.amount)),
      slippageBps,
    );

    // Plan commission — charged ONLY on the gain (redeemed − proportional cost
    // basis), and only for shares whose cost basis we recorded from deposits
    // made through Cosmos Pay. Shares with no known basis are taxed nothing.
    const feeBps = resolvePlanCommissionBps(this.config, consumer);
    const feeWallet = this.feeWallet();
    let feeA = 0n;
    let feeB = 0n;
    if (feeBps > 0) {
      const basis = await this.basis.costBasis(dto.source, dto.poolId, network);
      const fees = computeWithdrawCommission({
        shares,
        totalShares: total,
        remainingShares: basis.remainingShares,
        depositedShares: basis.depositedShares,
        costA: basis.costA,
        costB: basis.costB,
        reserveA: toStroops(resA.amount),
        reserveB: toStroops(resB.amount),
        slippageBps,
        feeBps,
      });
      feeA = fees.feeA;
      feeB = fees.feeB;
    }
    if (feeA + feeB > 0n && !feeWallet) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'A swap commission is configured (STELLAR_SWAP_FEE_BPS) but STELLAR_SWAP_FEE_WALLET is not set',
      );
    }

    const stellarCfg = this.config.get('stellar', { infer: true });

    // Pre-flight: the withdraw itself funds the fee payments (they come out of
    // the just-received reserves), so we only need the account to keep its XLM
    // minimum reserve plus the tx fee. Clear 400 instead of an on-chain reject.
    const opCount = 1 + (feeA > 0n ? 1 : 0) + (feeB > 0n ? 1 : 0);
    this.accounts.assertCanAfford(
      account,
      account.balances,
      [],
      false,
      BigInt(stellarCfg.baseFee) * BigInt(opCount),
    );

    const builder = new TransactionBuilder(account, {
      fee: stellarCfg.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    }).addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: dto.poolId,
        amount: fromStroops(shares),
        minAmountA: fromStroops(minA),
        minAmountB: fromStroops(minB),
      }),
    );
    // Collect the plan commission out of the just-received reserves.
    if (feeA > 0n && feeWallet) {
      builder.addOperation(
        Operation.payment({
          destination: feeWallet,
          asset: this.assetFromReserve(resA),
          amount: fromStroops(feeA),
        }),
      );
    }
    if (feeB > 0n && feeWallet) {
      builder.addOperation(
        Operation.payment({
          destination: feeWallet,
          asset: this.assetFromReserve(resB),
          amount: fromStroops(feeB),
        }),
      );
    }
    applyMemo(
      builder,
      memo,
      feeA + feeB > 0n ? LIQUIDITY_COMMISSION_MEMO : null,
    );

    const tx = builder.setTimeout(stellarCfg.timeoutSeconds).build();
    const op = await this.persist(consumer, {
      consumerId: local.id,
      kind: 'WITHDRAW' as const,
      network,
      source: dto.source,
      poolId: dto.poolId,
      assetA: resA.asset,
      assetAIssuer: resA.issuer,
      assetB: resB.asset,
      assetBIssuer: resB.issuer,
      amountA: fromStroops(minA),
      amountB: fromStroops(minB),
      shares: fromStroops(shares),
      minPrice: null,
      maxPrice: null,
      slippageBps,
      memo,
      idempotencyKey,
      feeBps,
      feeAmountA: fromStroops(feeA),
      feeAmountB: fromStroops(feeB),
      feeWallet: feeA + feeB > 0n ? feeWallet : null,
      tx,
      timeoutSeconds: stellarCfg.timeoutSeconds,
      request,
    });
    this.logger.log(
      `Created LP withdraw ${op.id}: ${fromStroops(shares)} shares of pool ` +
        `${dto.poolId.slice(0, 8)}… (consumer=${consumer.username}, network=${network})`,
    );
    return op;
  }

  // ── Read (operations) ───────────────────────────────────────────────────────
  async findAllOperations(
    consumer: GatewayConsumer,
    query: QueryLiquidityOperationsDto,
  ): Promise<{
    data: LiquidityPoolOperation[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.liquidityPoolOperation.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.liquidityPoolOperation.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  async findOneOperation(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<LiquidityOperationView> {
    return this.withQr(await this.findOwned(consumer, id));
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  /**
   * Relays the signed transaction to the network. The signed envelope must be
   * the one we built (hash-verified against the stored operation). A network
   * rejection finalizes the operation as FAILED **only if it is still
   * in-flight** — a concurrent observer that already marked it SUCCEEDED (and
   * captured cost basis) must not be overwritten. An unreachable network is a
   * 503 and leaves it re-submittable.
   *
   * The mechanics are {@link SignedTransactionRelay}'s, shared with swaps. What
   * is this module's own is {@link withDepositBasis}: settling a deposit here
   * captures its cost basis, exactly as the observer's settlement does.
   */
  async submit(
    consumer: GatewayConsumer,
    id: string,
    signedXdr: string,
  ): Promise<LiquiditySubmitOutcome> {
    const op = await this.findOwned(consumer, id);
    const { view, ...outcome } = await this.relay.submit(
      op,
      consumer.username,
      signedXdr,
      this.submission,
    );
    return { ...outcome, operation: view };
  }

  /** What relaying differs in for this table; see {@link submit}. */
  private get submission(): RelayProfile<
    LiquidityPoolOperation,
    LiquidityOperationView
  > {
    return {
      settlement: this.settlement,
      submittedEvent: 'LIQUIDITY_SUBMITTED',
      emit: (username, type, operation) => this.emit(username, type, operation),
      afterSucceeded: (operation) => this.withDepositBasis(operation),
      present: (operation) => this.withQr(operation),
      labels: {
        resource: 'liquidity pool operation',
        match: 'operation',
        log: 'LP operation',
      },
      logger: this.logger,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────────
  /**
   * Persists a new operation and emits `LIQUIDITY_CREATED`.
   *
   * Both unique indexes on the table can fire here. With an idempotency key the
   * caller recovers the existing row rather than seeing a raw P2002: a same-key
   * race rebuilds the same XDR, so it can trip `(network, txHash)` instead of
   * the key index — Postgres reports only one of the two violations, and which
   * one is arbitrary. Recovery returns the winner's row — provided the winner
   * was the same request, see {@link replay} — and, because the insert never
   * happened, emits no second `LIQUIDITY_CREATED`.
   */
  private async persist(
    consumer: GatewayConsumer,
    input: {
      consumerId: string;
      kind: 'DEPOSIT' | 'WITHDRAW';
      network: StellarNetwork;
      source: string;
      poolId: string;
      assetA: string;
      assetAIssuer: string | null;
      assetB: string;
      assetBIssuer: string | null;
      amountA: string;
      amountB: string;
      shares: string | null;
      minPrice: string | null;
      maxPrice: string | null;
      slippageBps: number;
      /** The caller's MEMO_ID; a commission MEMO_TEXT is never stored here. */
      memo: string | null;
      idempotencyKey: string | null;
      feeBps: number;
      feeAmountA: string;
      feeAmountB: string;
      feeWallet: string | null;
      tx: ReturnType<TransactionBuilder['build']>;
      timeoutSeconds: number;
      /** What the caller asked for — a same-key race winner is vetted against it. */
      request: LiquidityRequestTerms;
    },
  ): Promise<LiquidityOperationView> {
    const { tx, timeoutSeconds, request, ...data } = input;
    const xdr = tx.toXDR();
    let op: LiquidityPoolOperation;
    try {
      op = await this.prisma.liquidityPoolOperation.create({
        data: {
          ...data,
          status: 'PENDING',
          xdr,
          uri: sep7TxUri(xdr),
          txHash: Buffer.from(tx.hash()).toString('hex'),
          // The tx is only valid for its timeout window; after that it can't settle.
          expiresAt: new Date(Date.now() + timeoutSeconds * 1000),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = data.idempotencyKey
        ? await this.findByIdempotencyKey(data.consumerId, data.idempotencyKey)
        : null;
      if (raced) return this.replay(raced, request, consumer);
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A liquidity pool operation with this transaction hash already exists ' +
          'for this network. Two creates rebuilt the same Stellar sequence/XDR ' +
          '— use an Idempotency-Key on retries, or wait for the prior operation ' +
          'to settle/expire.',
      );
    }
    await this.emit(consumer.username, 'LIQUIDITY_CREATED', op);
    return this.withQr(op);
  }

  /**
   * Answers a request that reused an `Idempotency-Key`: the stored operation
   * when it is the same request, a 409 when it is not.
   *
   * A key is scoped to the consumer, and every anonymous wallet on the shared
   * public API key is the same consumer, so the stored row may be someone else's
   * envelope — a withdrawal or a deposit naming the caller's account, built for
   * the caller to sign. The conflict describes nothing about the stored
   * operation for the same reason.
   */
  private async replay(
    existing: LiquidityPoolOperation,
    request: LiquidityRequestTerms,
    consumer: GatewayConsumer,
  ): Promise<LiquidityOperationView> {
    const stored = { ...existing, memo: this.recordedMemoId(existing) };
    if (!liquidityOperationMatchesRequest(stored, request)) {
      this.logger.warn(
        `Idempotency-Key reused for a different liquidity pool request ` +
          `(operation=${existing.id}, consumer=${consumer.username})`,
      );
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'This Idempotency-Key was already used for a different liquidity pool ' +
          'request. Use a new key for a new request.',
      );
    }
    return this.withQr(existing);
  }

  /**
   * The unsigned envelope stored on `op`, or null when it cannot be read. That
   * never happens for a row this service built, so callers take null to mean
   * "this row cannot be vouched for" and fail closed.
   */
  private storedEnvelope(
    op: Pick<LiquidityPoolOperation, 'xdr' | 'network'>,
  ): Transaction | null {
    try {
      const tx = TransactionBuilder.fromXDR(
        op.xdr,
        this.stellar.passphrase(op.network as StellarNetwork),
      );
      return tx instanceof FeeBumpTransaction ? null : tx;
    } catch {
      return null;
    }
  }

  /**
   * The caller's MEMO_ID `op` was built with: null when it had none, undefined
   * when that cannot be established.
   *
   * The `memo` column answers when it is set, without decoding the envelope. A
   * null column does not settle it: rows built before the column existed hold
   * null whatever memo they carry. So a null is answered from the stored
   * envelope, which is authoritative both for a row with no memo and for one
   * that predates the column. An envelope carrying only the commission
   * MEMO_TEXT has no MEMO_ID, so it is null too. An envelope that cannot be
   * read is undefined, and the replay treats that as matching nothing.
   */
  private recordedMemoId(
    op: LiquidityPoolOperation,
  ): string | null | undefined {
    if (op.memo !== null) return op.memo;
    const envelope = this.storedEnvelope(op);
    if (!envelope) return undefined;
    const { type, value } = envelope.memo;
    return type === 'id' && typeof value === 'string' ? value : null;
  }

  private async findByIdempotencyKey(
    consumerId: string,
    idempotencyKey: string,
  ): Promise<LiquidityPoolOperation | null> {
    return this.prisma.liquidityPoolOperation.findUnique({
      where: { consumerId_idempotencyKey: { consumerId, idempotencyKey } },
    });
  }

  /**
   * At most one non-expired in-flight WITHDRAW per `(source, poolId, network)`.
   *
   * Two concurrent withdrawals both read the cost basis before either settles,
   * so each one sees the full unrealized gain and each one charges commission on
   * it — the customer is taxed twice for a single gain (or, symmetrically,
   * under-taxed once the basis is later consumed). Serializing the *creation* of
   * withdrawals for a position is the smallest fix: the basis can then only be
   * read while nothing else is racing to consume it.
   *
   * Scoped to `(consumerId, source, poolId, network)`.
   *
   * It used to be account-wide, reasoning that "the position belongs to the
   * Stellar account, so a second API key must not be a way around the guard".
   * The anti-circumvention half of that is already satisfied by `consumerId`: a
   * `Consumer` row is keyed on the APISIX *username* (`cosmos_<userId>`), not on
   * the credential, so every API key the same user holds resolves to one
   * consumer and cannot dodge the guard.
   *
   * What account-wide scoping additionally did was let any caller block anyone
   * else. `source` is a public Stellar address and nothing requires the caller
   * to control it, so a key with `liquidity:write` could post a 0.0000001-share
   * withdrawal naming a stranger's account and take the guard for a full
   * transaction-timeout window — repeatable indefinitely, a denial of service on
   * someone else's withdrawals. The swaps twin, `assertNoInflightSwap`, was
   * consumer-scoped all along; this was the outlier.
   *
   * Note this scopes differently from `LpCostBasisService.costBasis`,
   * deliberately. The basis must stay account-wide or a second organization
   * becomes a way to avoid the commission. This guard must be consumer-scoped or
   * a second organization becomes a way to block withdrawals. The residual — two
   * organizations withdrawing from one account concurrently both read the
   * pre-withdrawal basis and each under-tax — is the same read-then-write race
   * that already exists within a single consumer, and availability of a
   * withdrawal path is worth more than closing it here.
   *
   * Deposits are exempt: they compute no commission and read no basis, and
   * repeated deposits into one pool are a normal thing to do. A double-submitted
   * *identical* deposit is caught by the unique `(network, txHash)` index
   * instead.
   *
   * **Only a row that may already be on-chain holds the guard.** Consumer
   * scoping did not end the denial of service above on the shared public API
   * key, where every anonymous wallet is one consumer: a dust withdrawal naming
   * a stranger's account still handed every wallet user a 409 for that
   * position, one timeout window after another. So the guard now asks the
   * question the race actually turns on. A double read of the basis needs the
   * first withdrawal to have burned its shares on-chain before the second is
   * built, and a transaction can only be on-chain once the account has used its
   * sequence number. A row whose number is still ahead of the account cannot
   * have settled — and the withdrawal being built now takes that same number,
   * so at most one of the two can ever settle. The unsigned dust row is exactly
   * that case, and it no longer blocks.
   *
   * The residual, accepted: a row built before the account's latest transaction
   * does block until it expires, because from here "used by this row" and "used
   * by something else" look alike. Telling them apart takes a Horizon lookup per
   * row, and how many rows there are is the attacker's to choose.
   *
   * Only the oldest non-expired row is read. Envelopes are built from the
   * account's then-current sequence, which never goes backwards, so if the
   * oldest row's number is still unused, so is every later row's. A later row
   * with a lower number was built from a stale Horizon view: its number was
   * already spent when it was built, so it can never settle either. An envelope
   * that cannot be read blocks — nothing about that row can be vouched for.
   *
   * `accountSequence` must be read before a `TransactionBuilder` builds from the
   * account, since building advances it in place.
   */
  private async assertNoInflightWithdraw(
    consumerId: string,
    source: string,
    poolId: string,
    network: StellarNetwork,
    accountSequence: string,
  ): Promise<void> {
    const oldest = await this.prisma.liquidityPoolOperation.findFirst({
      where: {
        consumerId,
        kind: 'WITHDRAW',
        source,
        poolId,
        network,
        status: { in: [...LP_IN_FLIGHT_STATUSES] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      // The envelope is all we need — the response deliberately names no row.
      select: { xdr: true, network: true },
    });
    if (!oldest) return;

    const envelope = this.storedEnvelope(oldest);
    if (envelope && BigInt(envelope.sequence) > BigInt(accountSequence)) {
      return;
    }
    throw ApiError.conflict(
      ApiErrorCode.OperationInFlight,
      'A withdrawal from this pool is already in flight for this account. ' +
        'Wait for it to settle or expire before starting another — the ' +
        'commission on a withdrawal depends on the position it leaves behind.',
    );
  }

  // ── Status transitions ──────────────────────────────────────────────────────
  /**
   * The compare-and-swap settlement machine, shared with swaps.
   *
   * Built lazily rather than injected: it closes over `this.emit` and this
   * module's status sets, so it is a configured view of this service's own table
   * rather than a collaborator with its own lifecycle. It never writes cost-basis
   * columns (`sharesReceived` / `settledAmountA` / `settledAmountB`), so an error
   * transition cannot clobber a captured basis.
   */
  private get settlement(): SettlementRepository<LiquidityPoolOperation> {
    this.settlementRepo ??= new SettlementRepository<LiquidityPoolOperation>(
      this.prisma.liquidityPoolOperation,
      LP_CAN_SUCCEED_STATUSES,
      LP_IN_FLIGHT_STATUSES,
      { succeeded: 'LIQUIDITY_SUCCEEDED', failed: 'LIQUIDITY_FAILED' },
      (username, type, operation) => this.emit(username, type, operation),
    );
    return this.settlementRepo;
  }
  private settlementRepo?: SettlementRepository<LiquidityPoolOperation>;

  /**
   * Promotes an in-flight (or falsely-FAILED) operation to SUCCEEDED and
   * captures deposit cost basis. Idempotent if already SUCCEEDED. Used by
   * submit and the settlement observer so both writers share the same guard.
   */
  async finalizeSucceeded(
    id: string,
    username: string,
    txHash?: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, row } = await this.settlement.finalizeSucceeded(
      id,
      username,
      txHash,
    );
    return { applied, operation: await this.withDepositBasis(row) };
  }

  /**
   * What settling an operation implies for this module: a SUCCEEDED deposit's
   * cost basis is captured, and the row is re-read so the caller sees it.
   *
   * One function for both writers — {@link finalizeSucceeded} (the observer)
   * and the relay's post-settlement hook in {@link submit} — so a deposit
   * settled either way records its basis the same way. Anything not SUCCEEDED
   * is returned as it is.
   */
  private async withDepositBasis(
    operation: LiquidityPoolOperation,
  ): Promise<LiquidityPoolOperation> {
    if (operation.status !== 'SUCCEEDED') return operation;
    await this.basis.captureDepositBasis(operation);
    return this.prisma.liquidityPoolOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
  }

  /**
   * Same status transition as {@link finalizeSucceeded} but emits no webhook
   * **and captures no cost basis**. Used by the observer for historical
   * duplicate-hash rows (pre-`@@unique([network, txHash])`) so one on-chain
   * transaction yields a single `LIQUIDITY_SUCCEEDED`.
   *
   * Skipping the basis capture is the point, not an omission: the duplicates
   * describe *one* deposit, and its `liquidity_pool_deposited` effect reports
   * `shares_received` once. Capturing it on every row would count the same
   * shares two or more times in `LpCostBasisService.costBasis`, inflating
   * `remainingShares` so that shares acquired outside Cosmos Pay start being
   * taxed. The row the observer settles first keeps the basis; the phantoms stay
   * basis-less and are skipped by `aggregateCostBasis`.
   */
  async finalizeSucceededQuiet(
    id: string,
    txHash?: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, row } = await this.settlement.finalizeSucceededQuiet(
      id,
      txHash,
    );
    return { applied, operation: row };
  }

  /**
   * Marks FAILED only while the row is still in-flight. A liquidated
   * (`SUCCEEDED`) operation is left untouched — including its cost basis.
   */
  async finalizeFailed(
    id: string,
    username: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, row } = await this.settlement.finalizeFailed(id, username);
    return { applied, operation: row };
  }

  /**
   * Same status transition as {@link finalizeFailed} without a webhook — for
   * duplicate-hash phantom rows in the observer.
   */
  async finalizeFailedQuiet(
    id: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, row } = await this.settlement.finalizeFailedQuiet(id);
    return { applied, operation: row };
  }

  /**
   * Marks EXPIRED only while the row is still in-flight. Never degrades a
   * liquidated operation.
   */
  async finalizeExpired(
    id: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, row } = await this.settlement.finalizeExpired(id);
    return { applied, operation: row };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** Network follows the API key type (prod → public, dev → testnet). */
  private resolveNetwork(consumer: GatewayConsumer): StellarNetwork {
    return resolveNetwork(this.config, consumer);
  }

  /** Mirror the APISIX consumer locally so operations can be scoped to it. */
  private resolveConsumer(consumer: GatewayConsumer) {
    return this.consumers.resolve(consumer);
  }

  private feeWallet(): string {
    return this.config.get('stellar', { infer: true }).swap.feeWallet;
  }

  /** The SDK Asset for a parsed reserve (native or issued). */
  private assetFromReserve(r: LiquidityPoolReserve): Asset {
    return r.issuer ? new Asset(r.asset, r.issuer) : Asset.native();
  }

  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<LiquidityPoolOperation> {
    const op = await this.prisma.liquidityPoolOperation.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!op) {
      throw ApiError.notFound(`Liquidity pool operation ${id} not found`);
    }
    return op;
  }

  /** A stored operation with its SEP-7 QR and commission label attached. */
  private async withQr(
    op: LiquidityPoolOperation,
  ): Promise<LiquidityOperationView> {
    return {
      ...op,
      qr: await sep7Qr(op.uri),
      // A collected commission (feeWallet set) is labelled with the memo text.
      commissionMemo: op.feeWallet ? LIQUIDITY_COMMISSION_MEMO : null,
    };
  }

  private emit(
    username: string,
    type: WebhookEventType,
    data: LiquidityPoolOperation,
  ): Promise<boolean> {
    return this.webhooks.emit(username, type, data);
  }
}
