import { Injectable, Logger } from '@nestjs/common';
// Imported for the return annotation on `load`. TypeScript 6 refuses to infer a
// type it cannot name portably, and the inferred one here points into
// `@stellar/stellar-sdk/lib/esm/horizon` — a path that is an implementation
// detail of the SDK's build layout, not something a declaration should embed.
import type { Horizon } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { StellarNetwork } from '@/config/configuration';
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
}

/**
 * Loads Stellar accounts and answers trustline questions about them.
 *
 * Both `SwapsService` and `LiquidityPoolsService` carried a byte-identical
 * `loadAccount` — including the same Horizon-404 translation — plus two
 * different-looking spellings of the same trustline predicate
 * (`assertTrustline` for the source of a deposit, `assertDestinationCanReceive`
 * for the destination of a swap). They are the same question asked about
 * different addresses, so they are one method here.
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

  /** True when these balances include a trustline for `asset` (native: always). */
  hasTrustline(balances: BalanceEntry[], asset: ResolvedAsset): boolean {
    if (asset.code === 'native' || !asset.issuer) return true;
    return balances.some(
      (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
    );
  }

  /**
   * Throws unless `address` trusts `asset`. `context` completes the sentence
   * "it must trust the asset before …", so each caller keeps its own wording.
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
      `Account ${address} has no trustline for ${asset.code}:${asset.issuer} — ` +
        `it must trust the asset before ${context}`,
    );
  }

  /**
   * Asserts the source can afford an operation before we build the XDR: each
   * issued asset's trustline balance must cover its required amount, and the
   * native (XLM) balance must cover any native requirement plus the minimum
   * reserve (including a pending pool-share trustline) and the transaction fee.
   * Turns an otherwise on-chain op_underfunded into a clear 400.
   *
   * It sits beside {@link assertTrustline} because it is the same kind of
   * question — "can this account do that?" answered from a loaded account — and
   * the reserve arithmetic is protocol, not liquidity-pool policy. It lived
   * privately in the pools service with the base reserve as a bare literal.
   */
  assertCanAfford(
    account: { subentry_count?: number },
    balances: BalanceEntry[],
    sides: AffordabilitySide[],
    addingTrustline: boolean,
    txFeeStroops: bigint,
  ): void {
    // Native side: its own requirement + reserve (one base reserve per
    // subentry, +1 for a pending trustline) + the tx fee must all fit within
    // the XLM balance.
    const nativeReq =
      sides.find((s) => s.asset.code === 'native' || !s.asset.issuer)
        ?.required ?? 0n;
    const nativeBal = toStroops(
      balances.find((b) => b.asset_type === 'native')?.balance ?? '0',
    );
    const subentries =
      BigInt(account.subentry_count ?? 0) + (addingTrustline ? 1n : 0n);
    const reserve = (2n + subentries) * BASE_RESERVE_STROOPS;
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
}
