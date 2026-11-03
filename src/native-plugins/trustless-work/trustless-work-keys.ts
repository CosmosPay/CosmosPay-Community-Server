import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import type { ProtectedPaymentDeadlinePolicy } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type {
  AppConfig,
  StellarNetwork,
  TrustlessWorkNetworkConfig,
} from '@/config/configuration';
import { trustlessWorkEnvName } from '@/native-plugins/trustless-work/trustless-work-config';

/**
 * The accounts this plugin acts as, per network, and the one place their
 * secrets are turned into keypairs. Nothing here is ever logged or answered.
 *
 *  - the PLATFORM key signs deploys (paying their XLM) and the disputes the
 *    platform opens, and receives Cosmos Pay's fee;
 *  - the RESOLVER key resolves the disputes of the auto deadline policies;
 *  - the OPS resolver is only an address: its secret is in an ops wallet.
 *
 * A missing key is `503 misconfigured`, raised before Trustless Work is called.
 */
@Injectable()
export class TrustlessWorkKeys {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Whether this network can serve protected payments at all. */
  isConfigured(network: StellarNetwork): boolean {
    const cfg = this.network(network);
    return cfg.apiKey !== '' && cfg.platformSecret !== '';
  }

  platform(network: StellarNetwork): Keypair {
    const secret = this.network(network).platformSecret;
    if (!secret) {
      throw misconfigured(
        `Protected payments are not configured on ${network}: set ` +
          `${trustlessWorkEnvName(network, 'PLATFORM_SECRET')}.`,
      );
    }
    return Keypair.fromSecret(secret);
  }

  /** The automatic resolver, or null when this network has none. */
  resolver(network: StellarNetwork): Keypair | null {
    const secret = this.network(network).resolverSecret;
    return secret ? Keypair.fromSecret(secret) : null;
  }

  /** The ops resolver's address, or null when this network has none. */
  opsResolver(network: StellarNetwork): string | null {
    return this.network(network).opsResolver || null;
  }

  /**
   * The dispute resolver a new protected payment gets under `policy`: the ops
   * address for MANUAL_REVIEW, the automatic resolver for the auto policies.
   * Refused (`503 misconfigured`) when that account is not configured, so a
   * merchant never creates a payment whose deadline nobody can act on.
   */
  disputeResolverFor(
    network: StellarNetwork,
    policy: ProtectedPaymentDeadlinePolicy,
  ): string {
    if (policy === 'MANUAL_REVIEW') {
      const ops = this.opsResolver(network);
      if (!ops) {
        throw misconfigured(
          `MANUAL_REVIEW is not available on ${network}: set ` +
            `${trustlessWorkEnvName(network, 'OPS_RESOLVER')}.`,
        );
      }
      return ops;
    }
    const resolver = this.resolver(network);
    if (!resolver) {
      throw misconfigured(
        `${policy} is not available on ${network}: it needs the automatic ` +
          `resolver key, ${trustlessWorkEnvName(network, 'RESOLVER_SECRET')}.`,
      );
    }
    return resolver.publicKey();
  }

  /**
   * The keypair this server holds for `address`, if any: the platform or the
   * automatic resolver. Never the ops resolver, whose secret is not here.
   */
  serverKeyFor(network: StellarNetwork, address: string): Keypair | null {
    const cfg = this.network(network);
    if (cfg.platformSecret) {
      const platform = Keypair.fromSecret(cfg.platformSecret);
      if (platform.publicKey() === address) return platform;
    }
    const resolver = this.resolver(network);
    return resolver?.publicKey() === address ? resolver : null;
  }

  /** Every account this server acts as or names on `network`. */
  serverAccounts(network: StellarNetwork): string[] {
    const cfg = this.network(network);
    return [
      cfg.platformSecret
        ? Keypair.fromSecret(cfg.platformSecret).publicKey()
        : '',
      this.resolver(network)?.publicKey() ?? '',
      cfg.opsResolver,
    ].filter(Boolean);
  }

  /** The deploy pins, empty when unset. */
  pins(network: StellarNetwork): { deployer: string; wasmHash: string } {
    const cfg = this.network(network);
    return { deployer: cfg.deployerContract, wasmHash: cfg.contractWasmHash };
  }

  private network(network: StellarNetwork): TrustlessWorkNetworkConfig {
    return this.config.get('trustlessWork', { infer: true }).networks[network];
  }
}

function misconfigured(message: string): ApiError {
  return ApiError.unavailable(ApiErrorCode.Misconfigured, message);
}
