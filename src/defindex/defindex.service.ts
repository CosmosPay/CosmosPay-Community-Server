import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import DefindexSDK, { SupportedNetworks } from '@defindex/sdk';
import { AppConfig } from '@/config/configuration';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  DefindexDepositDto,
  DefindexSubmitDto,
  DefindexWithdrawDto,
  defindexAmount,
} from '@/defindex/dto/defindex.dto';

@Injectable()
export class DefindexService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private network(consumer: GatewayConsumer): SupportedNetworks {
    return resolveNetwork(this.config, consumer) === 'public'
      ? SupportedNetworks.MAINNET
      : SupportedNetworks.TESTNET;
  }

  private sdk(): DefindexSDK {
    const cfg = this.config.get('defindex', { infer: true });
    if (!cfg.apiKey) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'DeFindex is not configured',
      );
    }
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

  discover(consumer: GatewayConsumer) {
    const sdk = this.sdk() as DefindexSDK & {
      discoverVaults?: (network: SupportedNetworks) => Promise<unknown>;
    };
    if (typeof sdk.discoverVaults !== 'function') {
      return this.direct('/vault/discover', consumer);
    }
    return this.call(() => sdk.discoverVaults!(this.network(consumer)));
  }

  info(consumer: GatewayConsumer, vault: string) {
    return this.call(() =>
      this.sdk().getVaultInfo(vault, this.network(consumer)),
    );
  }

  balance(consumer: GatewayConsumer, vault: string, account: string) {
    return this.call(() =>
      this.sdk().getVaultBalance(vault, account, this.network(consumer)),
    );
  }

  deposit(consumer: GatewayConsumer, vault: string, dto: DefindexDepositDto) {
    return this.call(() =>
      this.sdk().depositToVault(
        vault,
        {
          caller: dto.caller,
          amounts: dto.amounts.map(defindexAmount),
          invest: dto.invest ?? true,
          slippageBps: dto.slippageBps ?? 100,
        },
        this.network(consumer),
      ),
    );
  }

  withdraw(consumer: GatewayConsumer, vault: string, dto: DefindexWithdrawDto) {
    return this.call(() =>
      this.sdk().withdrawShares(
        vault,
        {
          caller: dto.caller,
          shares: defindexAmount(dto.shares),
          slippageBps: dto.slippageBps ?? 100,
        },
        this.network(consumer),
      ),
    );
  }

  submit(consumer: GatewayConsumer, dto: DefindexSubmitDto) {
    return this.call(() =>
      this.sdk().sendTransaction(dto.xdr, this.network(consumer)),
    );
  }

  private async direct(
    path: string,
    consumer: GatewayConsumer,
  ): Promise<unknown> {
    const cfg = this.config.get('defindex', { infer: true });
    return this.call(async () => {
      const response = await fetch(
        `${cfg.baseUrl}${path}?network=${this.network(consumer)}`,
        {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(cfg.timeoutMs),
        },
      );
      if (!response.ok)
        throw new Error(`DeFindex responded with ${response.status}`);
      return (await response.json()) as unknown;
    });
  }
}
