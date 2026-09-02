import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Memo,
  Operation,
  TransactionBuilder,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk';
import QRCode from 'qrcode';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { ApiError, ApiErrorCode } from '../common/errors/api-error';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { resolvePlanCommissionBps } from '../common/plan-commission';
import { isUniqueViolation } from '../common/prisma-errors';
import { resolveNetwork } from '../common/stellar-network';
import { PrismaService } from '../prisma/prisma.service';
import { ConsumerResolverService } from '../common/services/consumer-resolver.service';
import { StellarAccountLoader } from '../stellar/account-loader.service';
import type { BalanceEntry } from '../stellar/account-loader.service';
import { assetLabel, resolveAsset, ResolvedAsset } from '../stellar/asset';
import { extractResultCodes } from '../stellar/horizon-errors';
import { applyMemo, resolveMemoId } from '../stellar/memo';
import { SettlementRepository } from '../stellar/settlement.repository';
import { StellarService } from '../stellar/stellar.service';
import type {
  LiquidityPoolOperation,
  SwapStatus,
  WebhookEventType,
} from '../../generated/prisma/client';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { applySlippage, fromStroops, toStroops } from '../swaps/swap-math';
import {
  aggregateCostBasis,
  computeWithdrawCommission,
  matchDeposit,
  priceBounds,
  proportionalShare,
} from './lp-math';
import {
  LP_CAN_SUCCEED_STATUSES,
  LP_IN_FLIGHT_STATUSES,
} from './lp-operation-transitions';
import { DepositLiquidityDto } from './dto/deposit-liquidity.dto';
import { QueryLiquidityOperationsDto } from './dto/query-liquidity-operations.dto';
import { QueryLiquidityPoolsDto } from './dto/query-pools.dto';
import { QueryLiquidityPositionsDto } from './dto/query-positions.dto';
import { WithdrawLiquidityDto } from './dto/withdraw-liquidity.dto';
import {
  LiquidityPoolEntity,
  LiquidityPoolListEntity,
  LiquidityPoolReserve,
  LiquidityPositionListEntity,
} from './entities/liquidity-pool.entity';

/**
 * On-chain MEMO_TEXT stamped on operations that collect the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (it is the canonical label).
 * Kept ≤ 28 bytes (the MEMO_TEXT limit).
 */
export const LIQUIDITY_COMMISSION_MEMO = 'Cosmos Liquidity Commission';

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

/** Resolved asset: its stored code/issuer and the SDK Asset for building txs. */
/** Minimal shape we read off a Horizon liquidity pool record. */
interface PoolRecord {
  id: string;
  paging_token: string;
  fee_bp: number;
  total_trustlines: string;
  total_shares: string;
  reserves: { asset: string; amount: string }[];
}

/** Minimal shape of a Horizon account balance entry. */
/**
 * Stellar AMM liquidity pools. Like swaps, this is **non-custodial**: the
 * service prices a deposit/withdraw against the pool's on-chain reserves,
 * assembles the unsigned transaction (a pool-share `changeTrust` when needed +
 * `liquidityPoolDeposit`/`liquidityPoolWithdraw`), and relays the signed
 * envelope the customer hands back. Funds never pass through Cosmos Pay.
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
  ) {}

  // ── Pools (Horizon proxy) ───────────────────────────────────────────────────
  async listPools(
    consumer: GatewayConsumer,
    query: QueryLiquidityPoolsDto,
  ): Promise<LiquidityPoolListEntity> {
    const network = this.resolveNetwork(consumer);
    let builder = this.stellar
      .server(network)
      .liquidityPools()
      .limit(query.limit)
      .order('desc');
    const filters: Asset[] = [];
    if (query.assetACode !== undefined || query.assetAIssuer !== undefined) {
      filters.push(resolveAsset(query.assetACode, query.assetAIssuer).asset);
    }
    if (query.assetBCode !== undefined || query.assetBIssuer !== undefined) {
      filters.push(resolveAsset(query.assetBCode, query.assetBIssuer).asset);
    }
    if (filters.length) builder = builder.forAssets(...filters);
    if (query.account) builder = builder.forAccount(query.account);
    if (query.cursor) builder = builder.cursor(query.cursor);

    let records: PoolRecord[];
    try {
      records = (await builder.call()).records;
    } catch (err) {
      this.logger.error('liquidityPools list failed', err);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not reach the Stellar network to list liquidity pools',
      );
    }
    return {
      data: records.map((r) => this.toPoolEntity(network, r)),
      cursor:
        records.length === query.limit
          ? records[records.length - 1].paging_token
          : null,
    };
  }

  async getPool(
    consumer: GatewayConsumer,
    poolId: string,
  ): Promise<LiquidityPoolEntity> {
    this.assertPoolId(poolId);
    const network = this.resolveNetwork(consumer);
    const pool = await this.fetchPool(network, poolId);
    if (!pool) {
      throw ApiError.notFound(
        `Liquidity pool ${poolId} not found on the ${network} network`,
      );
    }
    return this.toPoolEntity(network, pool);
  }

  // ── Positions ───────────────────────────────────────────────────────────────
  /** An account's pool share trustlines joined with each pool's reserves. */
  async positions(
    consumer: GatewayConsumer,
    query: QueryLiquidityPositionsDto,
  ): Promise<LiquidityPositionListEntity> {
    const network = this.resolveNetwork(consumer);
    const account = await this.accounts.load(network, query.account);
    const shares = (account.balances as BalanceEntry[]).filter(
      (b) => b.asset_type === 'liquidity_pool_shares' && b.liquidity_pool_id,
    );
    const data = await Promise.all(
      shares.map(async (entry) => {
        const pool = await this.fetchPool(network, entry.liquidity_pool_id!);
        if (!pool) return null;
        const held = toStroops(entry.balance ?? '0');
        const total = toStroops(pool.total_shares);
        const reserves = pool.reserves.map((r) => this.parseReserve(r));
        return {
          poolId: pool.id,
          shares: fromStroops(held),
          totalShares: pool.total_shares,
          shareOfPoolBps: total > 0n ? Number((held * 10_000n) / total) : 0,
          reserves,
          redeemable: reserves.map((r) => ({
            ...r,
            amount:
              total > 0n
                ? fromStroops(
                    proportionalShare(held, total, toStroops(r.amount)),
                  )
                : '0',
          })),
        };
      }),
    );
    return {
      account: query.account,
      network,
      data: data.filter((p) => p !== null),
    };
  }

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
    const slippageBps = this.resolveSlippage(dto.slippageBps);
    const memo = resolveMemoId(dto.memo);
    const idempotencyKey = this.resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );

    // Fast path: same key → same operation (no Horizon round-trip, no rebuild).
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) return this.withQr(existing);
    }

    // Canonical order: the protocol requires assetA < assetB. Reorder the pair
    // (and its amounts) if the caller passed them the other way around.
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
    const poolId = getLiquidityPoolId(
      'constant_product',
      poolShare.getLiquidityPoolParameters(),
    ).toString('hex');

    const pool = await this.fetchPool(network, poolId);
    const reserveA = pool ? toStroops(this.reserveOf(pool, a)) : 0n;
    const reserveB = pool ? toStroops(this.reserveOf(pool, b)) : 0n;
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
    this.assertCanAfford(
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
      idempotencyKey,
      // Deposits carry no commission; the cost basis is captured at settlement.
      feeBps: 0,
      feeAmountA: '0',
      feeAmountB: '0',
      feeWallet: null,
      tx,
      timeoutSeconds: stellarCfg.timeoutSeconds,
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
    const slippageBps = this.resolveSlippage(dto.slippageBps);
    const memo = resolveMemoId(dto.memo);
    const idempotencyKey = this.resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );

    // Fast path: same key → same operation (no Horizon round-trip, no rebuild).
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) return this.withQr(existing);
    }

    await this.assertNoInflightWithdraw(
      local.id,
      dto.source,
      dto.poolId,
      network,
    );

    const pool = await this.fetchPool(network, dto.poolId);
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

    const [resA, resB] = pool.reserves.map((r) => this.parseReserve(r));
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
      const basis = await this.costBasis(dto.source, dto.poolId, network);
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
    this.assertCanAfford(
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
      idempotencyKey,
      feeBps,
      feeAmountA: fromStroops(feeA),
      feeAmountB: fromStroops(feeB),
      feeWallet: feeA + feeB > 0n ? feeWallet : null,
      tx,
      timeoutSeconds: stellarCfg.timeoutSeconds,
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
    const [data, total] = await this.prisma.$transaction([
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
   */
  async submit(
    consumer: GatewayConsumer,
    id: string,
    signedXdr: string,
  ): Promise<LiquiditySubmitOutcome> {
    const op = await this.findOwned(consumer, id);

    if (op.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: op.txHash,
        operation: await this.withQr(op),
      };
    }
    if (!['PENDING', 'SUBMITTED', 'FAILED'].includes(op.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot submit a ${op.status} liquidity pool operation`,
      );
    }

    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(
        signedXdr,
        this.stellar.passphrase(op.network as StellarNetwork),
      );
    } catch {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'signedXdr is not a valid transaction envelope',
      );
    }
    if (tx.hash().toString('hex') !== op.txHash) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'The signed transaction does not match this operation',
      );
    }

    const submitted = await this.markSubmitted(op.id);
    // Observer may have liquidated the row between our read and this write.
    if (submitted.operation.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: submitted.operation.txHash,
        operation: await this.withQr(submitted.operation),
      };
    }
    if (submitted.operation.status !== 'SUBMITTED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot submit a ${submitted.operation.status} liquidity pool operation`,
      );
    }
    if (submitted.applied) {
      await this.emit(
        consumer.username,
        'LIQUIDITY_SUBMITTED',
        submitted.operation,
      );
    }

    try {
      const res = await this.stellar
        .server(op.network as StellarNetwork)
        .submitTransaction(tx);
      const succeeded = await this.finalizeSucceeded(
        op.id,
        consumer.username,
        res.hash,
      );
      this.logger.log(
        `LP operation ${op.id} submitted and confirmed (tx=${res.hash})`,
      );
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: succeeded.operation.txHash,
        operation: await this.withQr(succeeded.operation),
      };
    } catch (err) {
      const resultCodes = extractResultCodes(err);
      if (resultCodes) {
        const failed = await this.finalizeFailed(op.id, consumer.username);
        if (failed.operation.status === 'SUCCEEDED') {
          // Observer already settled this tx on-chain. Do not report failure
          // and do not touch the captured cost basis.
          this.logger.log(
            `LP operation ${op.id} Horizon rejection ignored; already SUCCEEDED`,
          );
          return {
            submitted: true,
            status: 'SUCCEEDED',
            txHash: failed.operation.txHash,
            operation: await this.withQr(failed.operation),
          };
        }
        this.logger.warn(
          `LP operation ${op.id} rejected on submit: ${resultCodes.join(', ')}`,
        );
        return {
          submitted: false,
          status: 'FAILED',
          reason: 'Transaction rejected by the network',
          resultCodes,
          operation: await this.withQr(failed.operation),
        };
      }
      this.logger.error(`LP operation ${op.id} submission error`, err);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not submit the transaction to the Stellar network',
      );
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────────
  /**
   * Persists a new operation and emits `LIQUIDITY_CREATED`.
   *
   * Both unique indexes on the table can fire here. With an idempotency key the
   * caller always recovers the existing row rather than seeing a 409: a same-key
   * race rebuilds the same XDR, so it can trip `(network, txHash)` instead of
   * the key index — Postgres reports only one of the two violations, and which
   * one is arbitrary. Recovery returns the winner's row and, because the insert
   * never happened, emits no second `LIQUIDITY_CREATED`.
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
      idempotencyKey: string | null;
      feeBps: number;
      feeAmountA: string;
      feeAmountB: string;
      feeWallet: string | null;
      tx: ReturnType<TransactionBuilder['build']>;
      timeoutSeconds: number;
    },
  ): Promise<LiquidityOperationView> {
    const { tx, timeoutSeconds, ...data } = input;
    const xdr = tx.toXDR();
    let op: LiquidityPoolOperation;
    try {
      op = await this.prisma.liquidityPoolOperation.create({
        data: {
          ...data,
          status: 'PENDING',
          xdr,
          uri: `web+stellar:tx?${new URLSearchParams({ xdr }).toString()}`,
          txHash: tx.hash().toString('hex'),
          // The tx is only valid for its timeout window; after that it can't settle.
          expiresAt: new Date(Date.now() + timeoutSeconds * 1000),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = data.idempotencyKey
        ? await this.findByIdempotencyKey(data.consumerId, data.idempotencyKey)
        : null;
      if (raced) return this.withQr(raced);
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

  /** Header wins over body; blank strings are treated as absent. */
  private resolveIdempotencyKey(header?: string, body?: string): string | null {
    const raw = (header ?? body)?.trim();
    return raw ? raw : null;
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
   * Note this scopes differently from {@link costBasis}, deliberately. The basis
   * must stay account-wide or a second organization becomes a way to avoid the
   * commission. This guard must be consumer-scoped or a second organization
   * becomes a way to block withdrawals. The residual — two organizations
   * withdrawing from one account concurrently both read the pre-withdrawal
   * basis and each under-tax — is the same read-then-write race that already
   * exists within a single consumer, and availability of a withdrawal path is
   * worth more than closing it here.
   *
   * Deposits are exempt: they compute no commission and read no basis, and
   * repeated deposits into one pool are a normal thing to do. A double-submitted
   * *identical* deposit is caught by the unique `(network, txHash)` index
   * instead.
   */
  private async assertNoInflightWithdraw(
    consumerId: string,
    source: string,
    poolId: string,
    network: string,
  ): Promise<void> {
    const existing = await this.prisma.liquidityPoolOperation.findFirst({
      where: {
        consumerId,
        kind: 'WITHDRAW',
        source,
        poolId,
        network,
        status: { in: [...LP_IN_FLIGHT_STATUSES] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      // Existence is all we need — the response deliberately names no row.
      select: { id: true },
    });
    if (existing) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'A withdrawal from this pool is already in flight for this account. ' +
          'Wait for it to settle or expire before starting another — the ' +
          'commission on a withdrawal depends on the position it leaves behind.',
      );
    }
  }

  // ── Status transitions ──────────────────────────────────────────────────────
  /**
   * Optimistic status guard: the UPDATE only matches rows still in `from`.
   * Never writes cost-basis columns (`sharesReceived` / `settledAmountA` /
   * `settledAmountB`), so an error transition cannot clobber a captured basis.
   */
  /**
   * The compare-and-swap settlement machine, shared with swaps.
   *
   * Built lazily rather than injected: it closes over `this.emit` and this
   * module's status sets, so it is a configured view of this service's own table
   * rather than a collaborator with its own lifecycle.
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
   * PENDING → SUBMITTED keeps the epoch (same settlement attempt).
   * FAILED → SUBMITTED bumps it so a later LIQUIDITY_FAILED is a new event.
   */
  private async markSubmitted(
    id: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, row } = await this.settlement.markSubmitted(id);
    return { applied, operation: row };
  }

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
    const { applied, row: operation } = await this.settlement.finalizeSucceeded(
      id,
      username,
      txHash,
    );
    if (operation.status === 'SUCCEEDED') {
      await this.captureDepositBasis(operation);
      const fresh = await this.prisma.liquidityPoolOperation.findUniqueOrThrow({
        where: { id },
      });
      return { applied, operation: fresh };
    }
    return { applied, operation };
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
   * shares two or more times in {@link costBasis}, inflating `remainingShares`
   * so that shares acquired outside Cosmos Pay start being taxed. The row the
   * observer settles first keeps the basis; the phantoms stay basis-less and are
   * skipped by `aggregateCostBasis`.
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

  /** Caller slippage, defaulted and clamped like swaps (same settings). */
  private resolveSlippage(requested?: number): number {
    const swap = this.config.get('stellar', { infer: true }).swap;
    const bps = requested ?? swap.slippageBps;
    if (bps > swap.maxSlippageBps) {
      throw ApiError.badRequest(
        ApiErrorCode.SlippageExceeded,
        `slippageBps ${bps} exceeds the maximum allowed (${swap.maxSlippageBps})`,
      );
    }
    return bps;
  }

  private assertPoolId(poolId: string): void {
    if (!/^[0-9a-f]{64}$/.test(poolId)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'poolId must be a 64-character lowercase hex liquidity pool id',
      );
    }
  }

  /** The pool must be trusted per constituent asset before it can be entered. */
  /**
   * Asserts the source can afford an operation before we build the XDR: each
   * issued asset's trustline balance must cover its required amount, and the
   * native (XLM) balance must cover any native requirement plus the minimum
   * reserve (including a pending pool-share trustline) and the transaction fee.
   * Turns an otherwise on-chain op_underfunded into a clear 400.
   */
  private assertCanAfford(
    account: { subentry_count?: number },
    balances: BalanceEntry[],
    sides: { asset: ResolvedAsset; required: bigint }[],
    addingTrustline: boolean,
    txFeeStroops: bigint,
  ): void {
    // Native side: its own requirement + reserve (0.5 XLM per subentry, +1 for a
    // pending trustline) + the tx fee must all fit within the XLM balance.
    const nativeReq =
      sides.find((s) => s.asset.code === 'native' || !s.asset.issuer)
        ?.required ?? 0n;
    const nativeBal = toStroops(
      balances.find((b) => b.asset_type === 'native')?.balance ?? '0',
    );
    const subentries =
      BigInt(account.subentry_count ?? 0) + (addingTrustline ? 1n : 0n);
    const reserve = (2n + subentries) * 5_000_000n; // 0.5 XLM base reserve/entry
    if (nativeBal - reserve - txFeeStroops < nativeReq) {
      throw ApiError.badRequest(
        ApiErrorCode.InsufficientBalance,
        `Insufficient XLM balance: need ${fromStroops(nativeReq)} plus ` +
          `~${fromStroops(reserve + txFeeStroops)} XLM reserve + network fee, ` +
          `but the account holds ${fromStroops(nativeBal)} XLM`,
      );
    }
    // Issued assets: the trustline balance must cover deposit + commission.
    for (const s of sides) {
      if (s.asset.code === 'native' || !s.asset.issuer) continue;
      const bal = toStroops(
        balances.find(
          (b) =>
            b.asset_code === s.asset.code && b.asset_issuer === s.asset.issuer,
        )?.balance ?? '0',
      );
      if (bal < s.required) {
        throw ApiError.badRequest(
          ApiErrorCode.InsufficientBalance,
          `Insufficient ${s.asset.code} balance: need ${fromStroops(s.required)}, ` +
            `but the account holds ${fromStroops(bal)}`,
        );
      }
    }
  }

  /**
   * Average-cost basis of the shares `source` still holds in `poolId` on
   * `network`, derived from our own SUCCEEDED deposits (which recorded the
   * shares + amounts at settlement) and withdrawals. Only deposits with a
   * captured `sharesReceived` count — positions opened outside Cosmos Pay have
   * no basis and are taxed nothing. All values are stroop bigints.
   *
   * Keyed on `(source, poolId, network)` **platform-wide**, deliberately not on
   * the consumer. Nothing binds a Stellar account to an API key, so scoping the
   * basis by consumer made the commission opt-out: deposit under organization A,
   * register a second (free) organization, withdraw the same account's shares
   * under organization B — the lookup found no deposits, `depositedShares` was
   * 0, and `computeWithdrawCommission` charged nothing on the entire gain. Cost
   * basis is a property of the Stellar account, because the on-chain position
   * is the account's, not the API key's.
   *
   * `network` is part of the key for the same reason: testnet is free, so
   * without it a testnet deposit would mint cost basis for a public-network
   * withdrawal.
   *
   * This is fee arithmetic only. The rows are read for their share/amount
   * columns and never surface in a response — listing and lookup stay scoped to
   * the calling consumer (see {@link findAllOperations} and {@link findOwned}),
   * so one tenant's operations are still invisible to another.
   *
   * Deliberately NOT scoped to the consumer, and it must stay that way: scoping
   * it is a fee-evasion hole. Deposit under org A, register a second free org,
   * withdraw the same account's shares under org B — the basis lookup finds
   * nothing and the whole gain is taxed at zero. That evasion is pinned by
   * "charges commission on a withdraw made under a different organization".
   *
   * The residual, accepted: because `feeAmountA`/`feeAmountB` are returned and
   * every other term is public, a caller who names a stranger's `source` can
   * solve for that account's per-share basis — i.e. learn which of its deposits
   * went through this platform. The underlying deposits are on-chain and
   * independently derivable, so the marginal disclosure is small, and closing it
   * by scoping would cost the fee rule above. Revisit only together with the
   * fee policy.
   */
  private async costBasis(
    source: string,
    poolId: string,
    network: string,
  ): Promise<{
    depositedShares: bigint;
    remainingShares: bigint;
    costA: bigint;
    costB: bigint;
  }> {
    const ops = await this.prisma.liquidityPoolOperation.findMany({
      where: { source, poolId, network, status: 'SUCCEEDED' },
      select: {
        kind: true,
        shares: true,
        sharesReceived: true,
        settledAmountA: true,
        settledAmountB: true,
        amountA: true,
        amountB: true,
      },
    });
    return aggregateCostBasis(ops);
  }

  /**
   * Records a settled deposit's cost basis (shares minted + reserves actually
   * deposited) from its on-chain `liquidity_pool_deposited` effect, so a later
   * withdraw can be taxed only on the gain. Idempotent: a no-op unless this is a
   * SUCCEEDED DEPOSIT whose basis has not been captured yet. Best-effort — a
   * Horizon hiccup just leaves the basis uncaptured (that deposit is then taxed
   * nothing). The UPDATE is itself guarded: it will not write over an existing
   * basis or onto a row that is no longer SUCCEEDED.
   */
  async captureDepositBasis(op: LiquidityPoolOperation): Promise<void> {
    if (op.kind !== 'DEPOSIT' || op.sharesReceived != null) return;
    if (op.status !== 'SUCCEEDED') return;
    try {
      const page = await this.stellar
        .server(op.network as StellarNetwork)
        .effects()
        .forTransaction(op.txHash)
        .call();
      const eff = page.records.find(
        (e) => (e as { type?: string }).type === 'liquidity_pool_deposited',
      ) as
        | {
            reserves_deposited?: { asset: string; amount: string }[];
            shares_received?: string;
          }
        | undefined;
      if (!eff?.shares_received) return;
      const keyA =
        op.assetA === 'native' ? 'native' : `${op.assetA}:${op.assetAIssuer}`;
      const keyB =
        op.assetB === 'native' ? 'native' : `${op.assetB}:${op.assetBIssuer}`;
      const reserves = eff.reserves_deposited ?? [];
      const result = await this.prisma.liquidityPoolOperation.updateMany({
        where: {
          id: op.id,
          kind: 'DEPOSIT',
          status: 'SUCCEEDED',
          sharesReceived: null,
        },
        data: {
          sharesReceived: eff.shares_received,
          settledAmountA:
            reserves.find((r) => r.asset === keyA)?.amount ?? op.amountA,
          settledAmountB:
            reserves.find((r) => r.asset === keyB)?.amount ?? op.amountB,
        },
      });
      if (result.count > 0) {
        this.logger.log(
          `Captured cost basis for deposit ${op.id}: ${eff.shares_received} shares`,
        );
      }
    } catch {
      this.logger.warn(`Failed to capture cost basis for deposit ${op.id}`);
    }
  }

  /** Horizon reserve strings are `native` or `CODE:ISSUER`. */
  private parseReserve(r: {
    asset: string;
    amount: string;
  }): LiquidityPoolReserve {
    if (r.asset === 'native') {
      return { asset: 'native', issuer: null, amount: r.amount };
    }
    const [code, issuer] = r.asset.split(':');
    return { asset: code, issuer: issuer ?? null, amount: r.amount };
  }

  /** The pool's reserve amount for a given constituent asset. */
  private reserveOf(pool: PoolRecord, asset: ResolvedAsset): string {
    const key =
      asset.code === 'native' ? 'native' : `${asset.code}:${asset.issuer}`;
    const reserve = pool.reserves.find((r) => r.asset === key);
    return reserve?.amount ?? '0';
  }

  private toPoolEntity(
    network: StellarNetwork,
    pool: PoolRecord,
  ): LiquidityPoolEntity {
    return {
      id: pool.id,
      network,
      feeBp: pool.fee_bp,
      totalTrustlines: pool.total_trustlines,
      totalShares: pool.total_shares,
      reserves: pool.reserves.map((r) => this.parseReserve(r)),
    };
  }

  /** Fetches a pool by id; null when it does not exist (yet). */
  private async fetchPool(
    network: StellarNetwork,
    poolId: string,
  ): Promise<PoolRecord | null> {
    try {
      return await this.stellar
        .server(network)
        .liquidityPools()
        .liquidityPoolId(poolId)
        .call();
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) return null;
      this.logger.error('Failed to load liquidity pool from Horizon', error);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not reach the Stellar network',
      );
    }
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

  /** Pulls Horizon's transaction/operation result codes off a failed submit. */
  private async withQr(
    op: LiquidityPoolOperation,
  ): Promise<LiquidityOperationView> {
    return {
      ...op,
      qr: await QRCode.toDataURL(op.uri),
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
