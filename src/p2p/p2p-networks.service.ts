import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { addressOfSecretKey } from '@/evm/evm-transaction';
import { hexToBytes } from '@/evm/rlp';
import {
  isP2pNetworkId,
  P2P_NETWORK_IDS,
  P2P_NETWORKS,
  type P2pNetworkId,
  type P2pTierNetwork,
  type P2pToken,
} from '@/p2p/p2p-networks';
import { toChecksumAddress } from '@/chains/chain-address';

/** One configured deployment: a network on a tier, with its contract and node. */
export interface P2pDeployment {
  tier: StellarNetwork;
  network: P2pNetworkId;
  name: string;
  chainId: number;
  contract: string;
  deployBlock: bigint;
  rpcUrl: string;
  tokens: readonly P2pToken[];
  confirmations: number;
  logBlockRange: number;
}

/**
 * The module's one reader of the `p2p` configuration: which networks run the
 * market on each tier, at which contract and through which node, with which
 * tokens, and the matcher's address. Whether a deployment is VERIFIED on-chain
 * is `P2pDeployments`'; this only says what was configured.
 */
@Injectable()
export class P2pNetworksService {
  private matcher?: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private settings() {
    return this.config.get('p2p', { infer: true });
  }

  /** Whether any tier has a deployment: the jobs run only then. */
  anyConfigured(): boolean {
    return (['public', 'testnet'] as const).some(
      (tier) => this.deployments(tier).length > 0,
    );
  }

  /** The configured deployments of a tier, in the table's order. */
  deployments(tier: StellarNetwork): P2pDeployment[] {
    const set = this.settings().tiers[tier];
    return P2P_NETWORK_IDS.flatMap((id) => {
      const contract = set.contracts[id];
      const entry = P2P_NETWORKS[id].tiers[tier];
      if (!contract || !entry) return [];
      return [this.deploymentOf(tier, id, contract, entry)];
    });
  }

  private deploymentOf(
    tier: StellarNetwork,
    network: P2pNetworkId,
    contract: string,
    entry: P2pTierNetwork,
  ): P2pDeployment {
    const set = this.settings().tiers[tier];
    const sandbox = this.config.get('sandbox', { infer: true });
    const cusd = entry.sandboxCusd ? sandbox.cusdAddresses[network] : undefined;
    const tokens = cusd
      ? [
          ...entry.tokens,
          { symbol: 'cUSD', address: toChecksumAddress(cusd), decimals: 6 },
        ]
      : entry.tokens;
    return {
      tier,
      network,
      name: P2P_NETWORKS[network].name,
      chainId: entry.chainId,
      contract: toChecksumAddress(contract),
      deployBlock: BigInt(set.deployBlocks[network] ?? 0),
      rpcUrl:
        set.rpcUrls[network] ??
        (tier === 'testnet' ? sandbox.rpcUrls[network] : undefined) ??
        entry.defaultRpcUrl ??
        '',
      tokens,
      confirmations: entry.confirmations,
      logBlockRange: entry.logBlockRange,
    };
  }

  /**
   * The caller's tier, when the market runs there: every keyed route but the
   * market overview starts here, so a tier with no deployment answers
   * `400 network_unsupported` everywhere (and nothing there ever needs the
   * data key or the matcher, which the boot only requires with a deployment).
   */
  tierFor(consumer: GatewayConsumer): StellarNetwork {
    const tier = resolveNetwork(this.config, consumer);
    if (this.deployments(tier).length === 0) {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        `The P2P market is not available on ${tier} yet.`,
      );
    }
    return tier;
  }

  /** The deployment of `network` on `tier`, or null when none is configured. */
  find(tier: StellarNetwork, network: string): P2pDeployment | null {
    if (!isP2pNetworkId(network)) return null;
    return this.deployments(tier).find((d) => d.network === network) ?? null;
  }

  /**
   * The deployment a request names, or `400 network_unsupported`. The message
   * lists the networks that ARE served on the key's tier, counted from the
   * configuration, never a fixed list.
   */
  require(tier: StellarNetwork, network: string): P2pDeployment {
    const found = this.find(tier, network);
    if (found) return found;
    const served = this.deployments(tier).map((d) => d.network);
    throw ApiError.badRequest(
      ApiErrorCode.NetworkUnsupported,
      served.length === 0
        ? `The P2P market is not available on ${tier} yet.`
        : `The P2P market does not run on ${network} on ${tier}. It runs on ${served.length} network${served.length === 1 ? '' : 's'} there: ${served.join(', ')}.`,
    );
  }

  /** A token of a deployment by address or symbol (case-insensitive), or `400 asset_unsupported`. */
  token(deployment: P2pDeployment, token: string): P2pToken {
    const wanted = token.trim().toLowerCase();
    const found = deployment.tokens.find(
      (t) =>
        t.address.toLowerCase() === wanted || t.symbol.toLowerCase() === wanted,
    );
    if (found) return found;
    throw ApiError.badRequest(
      ApiErrorCode.AssetUnsupported,
      `The P2P market does not trade ${token} on ${deployment.network}: it trades ${deployment.tokens.map((t) => t.symbol).join(', ') || 'no token yet'} there.`,
    );
  }

  /** The matcher's address, EIP-55; null when no key is configured. */
  matcherAddress(): string | null {
    const key = this.settings().matcherPrivateKey;
    if (!key) return null;
    this.matcher ??= addressOfSecretKey(hexToBytes(key));
    return this.matcher;
  }

  /** The matcher's secret key; only `P2pMatcherService` signs with it. */
  matcherKey(): Uint8Array {
    const key = this.settings().matcherPrivateKey;
    if (!key) {
      throw ApiError.misconfigured(
        'The P2P market cannot open orders on this deployment right now.',
        'P2P_MATCHER_PRIVATE_KEY is not set.',
      );
    }
    return hexToBytes(key);
  }

  timeoutMs(): number {
    return this.settings().timeoutMs;
  }
}
