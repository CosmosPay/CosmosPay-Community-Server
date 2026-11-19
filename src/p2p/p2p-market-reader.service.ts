import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '@/common/errors/api-error';
import { ReadThroughCache } from '@/common/read-through-cache';
import type { StellarNetwork } from '@/config/configuration';
import { P2P_MARKET_ARTIFACT } from '@/evm/p2p-market.artifact';
import { P2pChainClient } from '@/p2p/p2p-chain.client';
import {
  decodeBool,
  decodeChainOrder,
  decodeMatcherTerms,
  decodeUint,
  p2pCalldata,
  p2pMarketInitCode,
  type P2pChainOrder,
  type P2pMatcherTerms,
} from '@/p2p/p2p-market-abi';
import {
  P2pNetworksService,
  type P2pDeployment,
} from '@/p2p/p2p-networks.service';
import {
  P2P_BALANCE_READ_TTL_MS,
  P2P_DEPLOYMENT_CHECK_TTL_MS,
  P2P_DEPLOYMENT_RETRY_MS,
  P2P_PROTOCOL_READ_TTL_MS,
} from '@/p2p/p2p.constants';

/** Placeholder constructor arguments for the creation `eth_call`: any non-zero ones give the same runtime. */
const PROBE_ARGS = {
  owner: '0x0000000000000000000000000000000000000001',
  treasury: '0x0000000000000000000000000000000000000002',
  arbiter: '0x0000000000000000000000000000000000000003',
  feeBps: 0,
};

/** The contract's global state a quote prices with. */
export interface P2pProtocolState {
  feeBps: number;
  paused: boolean;
}

interface Verification {
  at: number;
  /** The deployment with only the tokens the contract allows, or null when it is not ours. */
  live: P2pDeployment | null;
}

/**
 * Typed reads of a `P2PMarket` deployment, and the check that a configured
 * address really is one before anything is served from it.
 *
 * The check: the code at the address must equal, byte for byte, the runtime a
 * creation `eth_call` of `P2P_MARKET_ARTIFACT` answers (the contract has no
 * immutables, so any constructor arguments give the same runtime), and each
 * listed token must be `tokenAllowed`. A wrong address is a network that is
 * never served (logged for the operator); a token the owner has not allowed
 * yet is left out of that network until it is. Verified deployments are
 * trusted for {@link P2P_DEPLOYMENT_CHECK_TTL_MS}.
 */
@Injectable()
export class P2pMarketReader {
  private readonly logger = new Logger(P2pMarketReader.name);
  private readonly verified = new Map<string, Verification>();
  private readonly inFlight = new Map<string, Promise<Verification>>();
  private readonly protocol = new ReadThroughCache<P2pProtocolState>(
    P2P_PROTOCOL_READ_TTL_MS,
    64,
  );
  private readonly reads = new ReadThroughCache<bigint>(
    P2P_BALANCE_READ_TTL_MS,
    2_000,
  );
  private readonly terms = new ReadThroughCache<P2pMatcherTerms>(
    P2P_BALANCE_READ_TTL_MS,
    2_000,
  );

  constructor(
    private readonly networks: P2pNetworksService,
    private readonly chain: P2pChainClient,
  ) {}

  /** The verified deployments of a tier; one that cannot be read right now is left out. */
  async liveDeployments(tier: StellarNetwork): Promise<P2pDeployment[]> {
    const checks = await Promise.all(
      this.networks.deployments(tier).map((d) =>
        this.verify(d).catch((err: unknown) => {
          this.logger.warn(
            `P2P deployment ${d.network}/${d.tier} could not be checked: ${String(err)}`,
          );
          return { at: 0, live: null };
        }),
      ),
    );
    return checks.flatMap((c) => (c.live ? [c.live] : []));
  }

  /**
   * The deployment a request names, verified: `400 network_unsupported` when
   * none is configured, `503 misconfigured` when the configured address is not
   * a P2PMarket (or allows none of the listed tokens).
   */
  async requireLive(
    tier: StellarNetwork,
    network: string,
  ): Promise<P2pDeployment> {
    const configured = this.networks.require(tier, network);
    const check = await this.verify(configured);
    if (!check.live) {
      throw ApiError.misconfigured(
        `The P2P market is not available on ${configured.name} right now.`,
        `P2P_MARKET_CONTRACTS_${tier === 'public' ? 'MAINNET' : 'TESTNET'} names ${configured.contract} for ${network}, which is not a P2PMarket of this build or allows none of the listed tokens.`,
      );
    }
    return check.live;
  }

  private verify(d: P2pDeployment): Promise<Verification> {
    const key = `${d.tier}:${d.network}:${d.contract}`;
    const cached = this.verified.get(key);
    const ttl = cached?.live
      ? P2P_DEPLOYMENT_CHECK_TTL_MS
      : P2P_DEPLOYMENT_RETRY_MS;
    if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached);
    const running = this.inFlight.get(key);
    if (running) return running;
    const check = this.check(d)
      .then((result) => {
        this.verified.set(key, result);
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, check);
    return check;
  }

  private async check(d: P2pDeployment): Promise<Verification> {
    const [code, expected] = await Promise.all([
      this.chain.getCode(d, d.contract),
      this.chain.ethCall(d, {
        data: p2pMarketInitCode(P2P_MARKET_ARTIFACT.bytecode, PROBE_ARGS),
      }),
    ]);
    if (code === '0x' || code.toLowerCase() !== expected.toLowerCase()) {
      this.logger.error(
        `P2P deployment ${d.network}/${d.tier} at ${d.contract} is not this build's P2PMarket ` +
          '(its code differs from the artifact runtime): the network is not served.',
      );
      return { at: Date.now(), live: null };
    }
    const allowed = await Promise.all(
      d.tokens.map(async (t) =>
        decodeBool(
          await this.chain.ethCall(d, {
            to: d.contract,
            data: p2pCalldata.tokenAllowed(t.address),
          }),
        ),
      ),
    );
    const tokens = d.tokens.filter((_, i) => allowed[i]);
    const refused = d.tokens.filter((_, i) => !allowed[i]);
    if (refused.length > 0) {
      this.logger.warn(
        `P2P deployment ${d.network}/${d.tier}: ${refused.map((t) => t.symbol).join(', ')} not allowed by the contract (setToken): not served there.`,
      );
    }
    return {
      at: Date.now(),
      live: tokens.length > 0 ? { ...d, tokens } : null,
    };
  }

  /** `protocolFeeBps()` and `paused()`, read at most once a minute per deployment. */
  protocolState(d: P2pDeployment): Promise<P2pProtocolState> {
    return this.protocol.get(`${d.tier}:${d.network}`, async () => {
      const [fee, paused] = await Promise.all([
        this.chain.ethCall(d, {
          to: d.contract,
          data: p2pCalldata.protocolFeeBps(),
        }),
        this.chain.ethCall(d, { to: d.contract, data: p2pCalldata.paused() }),
      ]);
      return {
        feeBps: Number(decodeUint(fee, 16)),
        paused: decodeBool(paused),
      };
    });
  }

  /** An account's free balance of `token` in the contract (cached briefly). */
  balanceOf(
    d: P2pDeployment,
    account: string,
    token: string,
    fresh = false,
  ): Promise<bigint> {
    const load = async () =>
      decodeUint(
        await this.chain.ethCall(d, {
          to: d.contract,
          data: p2pCalldata.balanceOf(account, token),
        }),
      );
    if (fresh) return load();
    return this.reads.get(
      `bal:${d.tier}:${d.network}:${account.toLowerCase()}:${token.toLowerCase()}`,
      load,
    );
  }

  /** What `seller` allows the matcher (cached briefly). */
  matcherTerms(
    d: P2pDeployment,
    seller: string,
    matcher: string,
    fresh = false,
  ): Promise<P2pMatcherTerms> {
    const load = async () =>
      decodeMatcherTerms(
        await this.chain.ethCall(d, {
          to: d.contract,
          data: p2pCalldata.matcherTermsOf(seller, matcher),
        }),
      );
    if (fresh) return load();
    return this.terms.get(
      `terms:${d.tier}:${d.network}:${seller.toLowerCase()}:${matcher.toLowerCase()}`,
      load,
    );
  }

  /** The bits `account` granted `operator`. */
  async permissionsOf(
    d: P2pDeployment,
    account: string,
    operator: string,
  ): Promise<number> {
    return Number(
      decodeUint(
        await this.chain.ethCall(d, {
          to: d.contract,
          data: p2pCalldata.permissionsOf(account, operator),
        }),
        8,
      ),
    );
  }

  /** An order as the contract stores it (`status` None when there is none). */
  async getOrder(d: P2pDeployment, id: bigint): Promise<P2pChainOrder> {
    return decodeChainOrder(
      await this.chain.ethCall(d, {
        to: d.contract,
        data: p2pCalldata.getOrder(id),
      }),
    );
  }
}
