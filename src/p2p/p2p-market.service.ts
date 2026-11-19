import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import type {
  P2pMarketNetworkEntity,
  P2pMarketOverviewEntity,
} from '@/p2p/entities/p2p-market.entity';
import { p2pChainInfo } from '@/p2p/p2p-chain-info';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2P_RAILS, railsFor } from '@/p2p/p2p-rails';
import {
  P2P_CURRENCIES,
  P2P_CURRENCY_CODES,
  P2P_MAX_INTEGRATOR_FEE_BPS,
  P2P_SELL_ACCEPT_WINDOW_SECONDS,
  P2P_SELL_BOND_BPS,
  P2P_SELL_PAYMENT_WINDOW_SECONDS,
  P2P_SELL_SETTLE_WINDOW_SECONDS,
  P2P_BUY_PAYMENT_WINDOW_SECONDS,
} from '@/p2p/p2p.constants';

/**
 * `GET /v1/p2p/market`: what a client needs to integrate on its key's tier.
 * The networks are the configured deployments that verified on-chain, each
 * with the fee and pause state the contract answers now; one whose node does
 * not answer is left out of this answer rather than failing it.
 */
@Injectable()
export class P2pMarketService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
  ) {}

  async overview(consumer: GatewayConsumer): Promise<P2pMarketOverviewEntity> {
    const tier = resolveNetwork(this.config, consumer);
    const deployments = await this.reader.liveDeployments(tier);
    const networks = (
      await Promise.all(
        deployments.map(async (d): Promise<P2pMarketNetworkEntity[]> => {
          try {
            const state = await this.reader.protocolState(d);
            return [
              {
                id: d.network,
                name: d.name,
                chainId: d.chainId,
                ...p2pChainInfo(d.network, tier),
                contract: d.contract,
                protocolFeeBps: state.feeBps,
                paused: state.paused,
                tokens: d.tokens.map((t) => ({ ...t })),
              },
            ];
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    return {
      tier,
      available: networks.length > 0,
      matcher: this.networks.matcherAddress(),
      bondBps: Number(P2P_SELL_BOND_BPS),
      maxIntegratorFeeBps: P2P_MAX_INTEGRATOR_FEE_BPS,
      windows: {
        buyPaymentWindow: P2P_BUY_PAYMENT_WINDOW_SECONDS,
        sellAcceptWindow: P2P_SELL_ACCEPT_WINDOW_SECONDS,
        sellPaymentWindow: P2P_SELL_PAYMENT_WINDOW_SECONDS,
        sellSettleWindow: P2P_SELL_SETTLE_WINDOW_SECONDS,
      },
      networks,
      currencies: P2P_CURRENCY_CODES.map((code) => ({
        code,
        decimals: P2P_CURRENCIES[code].decimals,
        rails: railsFor(code).map((id) => ({
          id,
          name: P2P_RAILS[id].name,
          fields: P2P_RAILS[id].fields.map((f) => ({
            name: f.name,
            description: f.description,
            required: f.required,
            ...(f.options ? { options: [...f.options] } : {}),
          })),
        })),
      })),
    };
  }
}
