import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type {
  AppConfig,
  StellarNetwork,
  ZkNetworkConfig,
} from '@/config/configuration';
import { NETWORK_PASSPHRASE } from '@/config/config.constants';
import type {
  ZkPaymentsConfigEntity,
  ZkTokenEntity,
} from '@/zk-payments/entities/zk-payment.entity';
import {
  ZK_PAYMENT_AUDITOR_ID,
  ZK_PAYMENT_FEE_BPS,
  ZK_PAYMENT_TOKEN_DECIMALS,
  ZK_PAYMENT_TOKEN_SYMBOL,
} from '@/zk-payments/zk-payments.constants';

/**
 * Which networks ZK payments run on, and with what: the one place the module
 * reads `zkPayments` from the configuration.
 */
@Injectable()
export class ZkNetworksService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** The network's setup, or null when the feature is off there. */
  get(network: StellarNetwork): ZkNetworkConfig | null {
    return this.config.get('zkPayments', { infer: true })[network];
  }

  /**
   * The network's setup, or `400 network_unsupported` when ZK payments do not
   * run there (mainnet, until an operator deploys it).
   */
  require(network: StellarNetwork): ZkNetworkConfig {
    const zk = this.get(network);
    if (!zk) {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        `ZK payments are not available on ${network} yet. They run on ` +
          'testnet only for now: use a dev API key.',
      );
    }
    return zk;
  }

  /**
   * A network's setup as a wallet needs it to register, prove and pay: the one
   * builder behind both `GET /v1/zk-payments/config` (the API key's network)
   * and the keyless `GET /v1/zk-checkout/config?network=`. Everything in it is
   * public on-chain data or a public URL; the auditor secret is never here.
   * A network without the feature answers `enabled: false` and nulls.
   */
  configFor(network: StellarNetwork): ZkPaymentsConfigEntity {
    const zk = this.get(network);
    return {
      enabled: zk !== null,
      network,
      rpcUrl: zk?.rpcUrl ?? null,
      networkPassphrase: NETWORK_PASSPHRASE[network],
      token: zk ? zkTokenOf(zk) : null,
      verifier: zk?.verifier ?? null,
      auditorRegistry: zk?.auditorRegistry ?? null,
      auditorId: ZK_PAYMENT_AUDITOR_ID,
      feeBps: ZK_PAYMENT_FEE_BPS,
      feeAccount: zk?.feeAccount ?? null,
    };
  }
}

/** The token as the config and the checkout describe it. */
export function zkTokenOf(zk: ZkNetworkConfig): ZkTokenEntity {
  return {
    contractId: zk.token,
    symbol: ZK_PAYMENT_TOKEN_SYMBOL,
    decimals: ZK_PAYMENT_TOKEN_DECIMALS,
    underlying: zk.underlying,
    deployedAtLedger: zk.deployedAtLedger,
  };
}

/** Whether a stored network name is one this service knows. */
export function isStellarNetwork(value: string): value is StellarNetwork {
  return value === 'public' || value === 'testnet';
}
