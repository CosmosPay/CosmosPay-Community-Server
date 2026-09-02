import { Injectable, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { StellarNetwork } from '@/config/configuration';
import { isHorizonNotFound } from '@/stellar/horizon-errors';
import { ResolvedAsset } from '@/stellar/asset';
import { StellarService } from '@/stellar/stellar.service';

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
  async load(network: StellarNetwork, address: string) {
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
}
