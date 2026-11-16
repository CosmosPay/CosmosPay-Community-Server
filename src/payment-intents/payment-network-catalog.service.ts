import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isChain } from '@/chains/chains.constants';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import type {
  PaymentNetworkEntity,
  PaymentNetworkListEntity,
} from '@/payment-intents/entities/payment-network.entity';
import {
  PAYMENT_NETWORKS,
  paymentNetworkName,
} from '@/payment-intents/payment-networks';
import { SandboxDepositRoute } from '@/sandbox-settlement/sandbox-deposit-route.service';

/**
 * Which networks a payment link can settle on for the caller's key, and in
 * which asset: what a form needs before it offers a network.
 *
 * On mainnet every network is available (Stellar, Solana and Monad with their
 * own links, the rest through deposit addresses, in any asset the cross-chain
 * route trades). On the test networks Stellar, Solana and Monad are paid
 * natively, and the rest only where the sandbox settles them, in their test
 * stablecoin, with the reason where it does not.
 */
@Injectable()
export class PaymentNetworkCatalog {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly sandbox: SandboxDepositRoute,
  ) {}

  forConsumer(consumer: GatewayConsumer): PaymentNetworkListEntity {
    const tier = resolveNetwork(this.config, consumer);
    const data = PAYMENT_NETWORKS.map((id): PaymentNetworkEntity => {
      const base = {
        id,
        name: paymentNetworkName(id),
        network: tier,
        settlesThroughDeposits: !isChain(id),
      };
      if (tier === 'public' || isChain(id)) {
        return { ...base, available: true, reason: null, asset: null };
      }
      const sandbox = this.sandbox.availability(id);
      return {
        ...base,
        available: sandbox.available,
        reason: sandbox.reason,
        asset: sandbox.asset
          ? {
              symbol: sandbox.asset.symbol,
              contract: sandbox.asset.contract,
              decimals: sandbox.asset.decimals,
            }
          : null,
      };
    });
    return { data };
  }
}
