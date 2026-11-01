import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import DefindexSDK, {
  type DepositParams,
  type SendTransactionResponse,
  SupportedNetworks,
  type VaultTransactionResponse,
  type WithdrawSharesParams,
} from '@defindex/sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { AppConfig, StellarNetwork } from '@/config/configuration';

/** DeFindex's name for each Stellar network this service serves. */
const DEFINDEX_NETWORKS: Record<StellarNetwork, SupportedNetworks> = {
  public: SupportedNetworks.MAINNET,
  testnet: SupportedNetworks.TESTNET,
};

/**
 * The DeFindex API, as this plugin uses it: the one place that holds the API
 * key, builds DeFindex's URLs and turns its failures into this service's errors.
 *
 * A deployment without `DEFINDEX_API_KEY` answers `503 misconfigured` before
 * any call. Every other failure (an HTTP error DeFindex answered, a timeout, a
 * socket error) is `502 provider_error`: the SDK rejects with DeFindex's body
 * or with axios' error and does not tell them apart.
 */
@Injectable()
export class DefindexClient {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Every vault DeFindex lists on the network (the SDK has no method for it). */
  discoverVaults(network: StellarNetwork): Promise<unknown> {
    const cfg = this.settings();
    return this.call(async () => {
      const response = await fetch(
        `${cfg.baseUrl}/vault/discover?network=${DEFINDEX_NETWORKS[network]}`,
        {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(cfg.timeoutMs),
        },
      );
      if (!response.ok) {
        throw new Error(`DeFindex responded with ${response.status}`);
      }
      return (await response.json()) as unknown;
    });
  }

  vaultInfo(network: StellarNetwork, vault: string): Promise<unknown> {
    const sdk = this.sdk();
    return this.call(() => sdk.getVaultInfo(vault, DEFINDEX_NETWORKS[network]));
  }

  vaultBalance(
    network: StellarNetwork,
    vault: string,
    account: string,
  ): Promise<unknown> {
    const sdk = this.sdk();
    return this.call(() =>
      sdk.getVaultBalance(vault, account, DEFINDEX_NETWORKS[network]),
    );
  }

  /** An unsigned deposit into `vault`, simulated by DeFindex. */
  deposit(
    network: StellarNetwork,
    vault: string,
    params: DepositParams,
  ): Promise<VaultTransactionResponse> {
    const sdk = this.sdk();
    return this.call(() =>
      sdk.depositToVault(vault, params, DEFINDEX_NETWORKS[network]),
    );
  }

  /** An unsigned burn of vault shares for the underlying assets. */
  withdrawShares(
    network: StellarNetwork,
    vault: string,
    params: WithdrawSharesParams,
  ): Promise<VaultTransactionResponse> {
    const sdk = this.sdk();
    return this.call(() =>
      sdk.withdrawShares(vault, params, DEFINDEX_NETWORKS[network]),
    );
  }

  /** Broadcasts a signed transaction through DeFindex and waits for its result. */
  send(
    network: StellarNetwork,
    signedXdr: string,
  ): Promise<SendTransactionResponse> {
    const sdk = this.sdk();
    return this.call(() =>
      sdk.sendTransaction(signedXdr, DEFINDEX_NETWORKS[network]),
    );
  }

  /** How long one DeFindex call may take: the submit's claim outlives it. */
  get timeoutMs(): number {
    return this.config.get('defindex', { infer: true }).timeoutMs;
  }

  private settings(): AppConfig['defindex'] {
    const cfg = this.config.get('defindex', { infer: true });
    if (!cfg.apiKey) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'DeFindex is not configured',
      );
    }
    return cfg;
  }

  private sdk(): DefindexSDK {
    const cfg = this.settings();
    return new DefindexSDK({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      timeout: cfg.timeoutMs,
    });
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        error instanceof Error ? error.message : 'DeFindex request failed',
      );
    }
  }
}
