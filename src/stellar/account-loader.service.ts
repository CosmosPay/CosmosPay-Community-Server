import { Injectable, Logger } from '@nestjs/common';
// Imported for the return annotation on `load`. TypeScript 6 refuses to infer a
// type it cannot name portably, and the inferred one here points into
// `@stellar/stellar-sdk/lib/esm/horizon` — a path that is an implementation
// detail of the SDK's build layout, not something a declaration should embed.
import type { Horizon } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { StellarNetwork } from '@/config/configuration';
import {
  minimumBalanceStroops,
  nativeBalanceStroops,
  nativeSellingLiabilitiesStroops,
  type ReserveFields,
} from '@/stellar/account-reserve';
import { isHorizonNotFound } from '@/stellar/horizon-errors';
import { ResolvedAsset } from '@/stellar/asset';
import { BASE_RESERVE_STROOPS } from '@/stellar/stellar.constants';
import { StellarService } from '@/stellar/stellar.service';
import { fromStroops, toStroops } from '@/swaps/swap-math';

/** One asset an operation spends from the source, and how much of it. */
export interface AffordabilitySide {
  asset: ResolvedAsset;
  /** In stroops. */
  required: bigint;
}

/** A balance line as Horizon returns it on an account. */
export interface BalanceEntry {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  balance?: string;
  selling_liabilities?: string;
}

/** A trustline the transaction's own source adds, and what else it spends. */
export interface TrustlineReserveCheck {
  /** The account that signs, and adds the trustline. */
  address: string;
  asset: ResolvedAsset;
  /** XLM the same transaction sends away, in stroops (zero for an issued asset). */
  nativeSpent: bigint;
  /** The whole transaction's fee, in stroops. */
  txFee: bigint;
}

/**
 * Loads Stellar accounts and answers trustline questions about them.
 *
 * Both `SwapsService` and `LiquidityPoolsService` carried a byte-identical
 * `loadAccount`, including the same Horizon-404 translation, plus two
 * different-looking spellings of the same trustline predicate. The predicate is
 * one method here ({@link hasTrustline}); what a missing trustline means is not,
 * because it depends on who lacks it: the account that signs can add it in the
 * same transaction (see {@link assertCanAddTrustline}), while any other account
 * can only add it itself ({@link assertCanReceive}).
 */
@Injectable()
export class StellarAccountLoader {
  private readonly logger = new Logger(StellarAccountLoader.name);

  constructor(private readonly stellar: StellarService) {}

  /**
   * Loads an account, translating Horizon's failure modes into the API's.
   *
   * A 404 is the caller's problem (the account does not exist or is unfunded)
   * and is a 400 naming the address; anything else is ours and is a 503 that
   * says nothing about our infrastructure.
   */
  async load(
    network: StellarNetwork,
    address: string,
  ): Promise<Horizon.AccountResponse> {
    try {
      return await this.stellar.server(network).loadAccount(address);
    } catch (error: unknown) {
      if (isHorizonNotFound(error)) {
        throw ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          `Account ${address} not found or not funded on the ${network} network`,
        );
      }
      this.logger.error('Failed to load account from Horizon', error);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not reach the Stellar network',
      );
    }
  }

  /**
   * True when these balances include a trustline for `asset`. Native XLM needs
   * none, and neither does `holder` when it is the asset's own issuer: an issuer
   * holds no trustline to the asset it issues, and receiving it simply burns it.
   */
  hasTrustline(
    balances: BalanceEntry[],
    asset: ResolvedAsset,
    holder?: string,
  ): boolean {
    if (asset.code === 'native' || !asset.issuer) return true;
    if (holder === asset.issuer) return true;
    return balances.some(
      (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
    );
  }

  /**
   * Throws unless `address` trusts `asset`. `context` completes the sentence
   * "it must trust the asset before …", so each caller keeps its own wording.
   *
   * For an account that must already HOLD the asset (a pool deposit spends it):
   * adding the trustline in the same transaction would leave it at zero, so the
   * operation fails anyway, and refusing is all this service can do.
   */
  assertTrustline(
    balances: BalanceEntry[],
    asset: ResolvedAsset,
    address: string,
    context: string,
  ): void {
    if (this.hasTrustline(balances, asset)) return;
    throw ApiError.badRequest(
      ApiErrorCode.TrustlineMissing,
      `Account ${address} has no trustline for ${asset.code}:${asset.issuer}. ` +
        `It must trust the asset before ${context}`,
    );
  }

  /**
   * Throws unless `address`, an account that signs nothing this service
   * builds, can receive `asset`. A trustline is a `changeTrust` its own account
   * must sign, so a transaction someone else signs can never add it: the
   * message says so, and says who has to act.
   *
   * `what` names what it would receive ("the swap", "this payment").
   */
  assertCanReceive(
    balances: BalanceEntry[],
    asset: ResolvedAsset,
    address: string,
    what: string,
  ): void {
    if (this.hasTrustline(balances, asset, address)) return;
    throw ApiError.badRequest(
      ApiErrorCode.TrustlineMissing,
      `Account ${address} has no trustline for ${asset.code}:${asset.issuer}, ` +
        `so it cannot receive ${what}. Only that account can add the ` +
        'trustline, by signing a transaction of its own: ask its owner to add ' +
        'it, then try again.',
    );
  }

  /**
   * Asserts the source can afford an operation before we build the XDR: each
   * issued asset's trustline balance must cover its required amount, and the
   * native (XLM) balance must cover any native requirement plus the minimum
   * balance (including a pending pool-share trustline), the XLM its open offers
   * hold, and the transaction fee. Turns an otherwise on-chain op_underfunded
   * into a clear 400.
   *
   * It sits beside {@link assertTrustline} because it is the same kind of
   * question — "can this account do that?" answered from a loaded account — and
   * the reserve arithmetic is protocol, not liquidity-pool policy. It lived
   * privately in the pools service with the base reserve as a bare literal.
   */
  assertCanAfford(
    account: ReserveFields,
    balances: BalanceEntry[],
    sides: AffordabilitySide[],
    addingTrustline: boolean,
    txFeeStroops: bigint,
  ): void {
    // Native side: its own requirement + the minimum balance (one base reserve
    // per subentry, +1 for a pending trustline) + what open offers hold + the
    // tx fee must all fit within the XLM balance.
    const nativeReq =
      sides.find((s) => s.asset.code === 'native' || !s.asset.issuer)
        ?.required ?? 0n;
    const nativeBal = nativeBalanceStroops(balances);
    const reserve =
      minimumBalanceStroops(account, addingTrustline ? 1n : 0n) +
      nativeSellingLiabilitiesStroops(balances);
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
   * Refuses, before anything is built, a transaction whose own source adds a
   * trustline it cannot pay the reserve of. A trustline is one more subentry,
   * so it raises the account's minimum balance by one base reserve; the network
   * would otherwise take the fee and fail the `changeTrust` with
   * `op_low_reserve` (or the payment after it with `op_underfunded`).
   *
   * What must fit in the XLM balance: the new minimum balance (Horizon's
   * subentry and sponsorship counts, plus this trustline), the XLM its open
   * offers hold, the XLM the same transaction sends, and the fee.
   */
  assertCanAddTrustline(
    account: ReserveFields,
    balances: BalanceEntry[],
    check: TrustlineReserveCheck,
  ): void {
    const balance = nativeBalanceStroops(balances);
    const minimum = minimumBalanceStroops(account, 1n);
    const offers = nativeSellingLiabilitiesStroops(balances);
    const needed = minimum + offers + check.nativeSpent + check.txFee;
    if (balance >= needed) return;

    const parts = [`its new minimum balance of ${fromStroops(minimum)} XLM`];
    if (offers > 0n) {
      parts.push(`${fromStroops(offers)} XLM held by its open offers`);
    }
    if (check.nativeSpent > 0n) {
      parts.push(`the ${fromStroops(check.nativeSpent)} XLM it sends`);
    }
    parts.push(`the ${fromStroops(check.txFee)} XLM network fee`);
    throw ApiError.badRequest(
      ApiErrorCode.InsufficientBalance,
      `Account ${check.address} cannot pay for the ${check.asset.code} ` +
        `trustline this transaction adds: a trustline locks another ` +
        `${fromStroops(BASE_RESERVE_STROOPS)} XLM of its balance, so it needs ` +
        `${fromStroops(needed)} XLM (${parts.join(', ')}) but holds ` +
        `${fromStroops(balance)} XLM. Add at least ` +
        `${fromStroops(needed - balance)} XLM to it, then try again.`,
    );
  }
}
