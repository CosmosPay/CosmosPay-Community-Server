import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset } from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import type { BalanceEntry } from '@/stellar/account-loader.service';
import { resolveAsset, ResolvedAsset } from '@/stellar/asset';
import { StellarService } from '@/stellar/stellar.service';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import { proportionalShare } from '@/liquidity-pools/lp-math';
import { QueryLiquidityPoolsDto } from '@/liquidity-pools/dto/query-pools.dto';
import { QueryLiquidityPositionsDto } from '@/liquidity-pools/dto/query-positions.dto';
import {
  LiquidityPoolEntity,
  LiquidityPoolListEntity,
  LiquidityPoolReserve,
  LiquidityPositionListEntity,
} from '@/liquidity-pools/entities/liquidity-pool.entity';
import {
  POSITIONS_MAX_POOL_PAGES,
  POSITIONS_POOL_PAGE_SIZE,
} from '@/liquidity-pools/liquidity-pools.constants';

/** Minimal shape we read off a Horizon liquidity pool record. */
export interface PoolRecord {
  id: string;
  paging_token: string;
  fee_bp: number;
  total_trustlines: string;
  total_shares: string;
  reserves: { asset: string; amount: string }[];
}

/** Horizon reserve strings are `native` or `CODE:ISSUER`. */
export function parseReserve(r: {
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
export function reserveOf(pool: PoolRecord, asset: ResolvedAsset): string {
  const key =
    asset.code === 'native' ? 'native' : `${asset.code}:${asset.issuer}`;
  const reserve = pool.reserves.find((r) => r.asset === key);
  return reserve?.amount ?? '0';
}

/**
 * Reads liquidity pools and pool-share positions from Horizon.
 *
 * Split out of `LiquidityPoolsService`, which used to browse public ledger data
 * *and* build deposit/withdraw envelopes *and* keep cost basis. These reads have
 * their own reason to change — Horizon's paging, its rate limit, the shape of a
 * pool record — and none of them touches this service's table, so the read
 * routes of the controller come straight here.
 *
 * Every read is ledger data, not tenant data: the network follows the caller's
 * key, but nothing here is scoped to (or reveals anything about) a consumer.
 */
@Injectable()
export class LiquidityPoolReaderService {
  private readonly logger = new Logger(LiquidityPoolReaderService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly stellar: StellarService,
    private readonly accounts: StellarAccountLoader,
  ) {}

  async listPools(
    consumer: GatewayConsumer,
    query: QueryLiquidityPoolsDto,
  ): Promise<LiquidityPoolListEntity> {
    const network = resolveNetwork(this.config, consumer);
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
    const network = resolveNetwork(this.config, consumer);
    const pool = await this.fetchPool(network, poolId);
    if (!pool) {
      throw ApiError.notFound(
        `Liquidity pool ${poolId} not found on the ${network} network`,
      );
    }
    return this.toPoolEntity(network, pool);
  }

  /** An account's pool share trustlines joined with each pool's reserves. */
  async positions(
    consumer: GatewayConsumer,
    query: QueryLiquidityPositionsDto,
  ): Promise<LiquidityPositionListEntity> {
    const network = resolveNetwork(this.config, consumer);
    const account = await this.accounts.load(network, query.account);
    const shares = (account.balances as BalanceEntry[]).filter(
      (b) => b.asset_type === 'liquidity_pool_shares' && b.liquidity_pool_id,
    );
    const pools = shares.length
      ? await this.poolsForAccount(network, query.account)
      : new Map<string, PoolRecord>();
    // Walk the balances, not the listing, so positions keep the order they
    // always had. A share balance whose pool is not listed is dropped, as a
    // per-pool 404 used to drop it.
    const data = shares.map((entry) => {
      const pool = pools.get(entry.liquidity_pool_id!);
      if (!pool) return null;
      const held = toStroops(entry.balance ?? '0');
      const total = toStroops(pool.total_shares);
      const reserves = pool.reserves.map((r) => parseReserve(r));
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
              ? fromStroops(proportionalShare(held, total, toStroops(r.amount)))
              : '0',
        })),
      };
    });
    return {
      account: query.account,
      network,
      data: data.filter((p) => p !== null),
    };
  }

  /**
   * Fetches a pool by id; null when it does not exist (yet).
   *
   * Public because the envelope builders price against the same record: a
   * deposit into a pool nobody has funded yet is legitimate, so "absent" is an
   * answer here, not an error — only an unreachable Horizon is.
   */
  async fetchPool(
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

  /**
   * Every pool `account` holds shares in, keyed by pool id — listed a page at a
   * time instead of looked up one request per pool. See
   * {@link POSITIONS_MAX_POOL_PAGES} for what the per-pool fan-out cost.
   */
  private async poolsForAccount(
    network: StellarNetwork,
    account: string,
  ): Promise<Map<string, PoolRecord>> {
    const pools = new Map<string, PoolRecord>();
    let cursor: string | undefined;
    for (let page = 0; page < POSITIONS_MAX_POOL_PAGES; page++) {
      let builder = this.stellar
        .server(network)
        .liquidityPools()
        .forAccount(account)
        .limit(POSITIONS_POOL_PAGE_SIZE);
      if (cursor) builder = builder.cursor(cursor);

      let records: PoolRecord[];
      try {
        records = (await builder.call()).records;
      } catch (err) {
        this.logger.error('liquidityPools for account failed', err);
        throw ApiError.unavailable(
          ApiErrorCode.ProviderUnavailable,
          'Could not reach the Stellar network',
        );
      }
      for (const record of records) pools.set(record.id, record);
      if (records.length < POSITIONS_POOL_PAGE_SIZE) break;
      cursor = records[records.length - 1].paging_token;
    }
    return pools;
  }

  private assertPoolId(poolId: string): void {
    if (!/^[0-9a-f]{64}$/.test(poolId)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'poolId must be a 64-character lowercase hex liquidity pool id',
      );
    }
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
      reserves: pool.reserves.map((r) => parseReserve(r)),
    };
  }
}
