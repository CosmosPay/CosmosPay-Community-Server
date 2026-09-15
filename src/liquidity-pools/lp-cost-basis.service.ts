import { Injectable, Logger } from '@nestjs/common';
import { StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarService } from '@/stellar/stellar.service';
import type { LiquidityPoolOperation } from '@generated/prisma/client';
import { aggregateCostBasis } from '@/liquidity-pools/lp-math';

/**
 * The cost basis that liquidity pool withdraw commission is charged against.
 *
 * Split out of `LiquidityPoolsService` because it has two writers that are not
 * that service's request flow: the settlement observer captures a deposit's
 * basis when it settles one, and re-tries captures that a Horizon hiccup missed.
 * Neither needs the envelope builders, and the rules here — what counts as a
 * basis, and whose — are fee policy with their own history (see
 * {@link costBasis}), so they are one place rather than a section of another
 * file.
 */
@Injectable()
export class LpCostBasisService {
  private readonly logger = new Logger(LpCostBasisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
  ) {}

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
   * the calling consumer (see `LiquidityPoolsService.findAllOperations` and
   * `findOwned`), so one tenant's operations are still invisible to another.
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
  async costBasis(
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
   * nothing until the observer's backfill retries it). The UPDATE is itself
   * guarded: it will not write over an existing basis or onto a row that is no
   * longer SUCCEEDED.
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
}
