import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isChain } from '@/chains/chains.constants';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import { isEvmChain } from '@/evm/evm.constants';
import { evmPayLinkRefusal } from '@/payment-intents/chain-pay-link-builder.service';
import type {
  PaymentNetworkEntity,
  PaymentNetworkListEntity,
} from '@/payment-intents/entities/payment-network.entity';
import { EvmDepositAddressFactory } from '@/payment-intents/evm-deposit-address.factory';
import {
  PAYMENT_NETWORKS,
  type PaymentNetwork,
  paymentNetworkName,
} from '@/payment-intents/payment-networks';
import { SandboxDepositRoute } from '@/sandbox-settlement/sandbox-deposit-route.service';

/**
 * Which networks a payment link can settle on for the caller's key, and in
 * which asset: what a form needs before it offers a network.
 *
 * On mainnet every network is available (the four chains settled natively
 * with their own links, the rest through deposit addresses, in any asset the
 * cross-chain route trades). On the test networks the four chains are paid
 * natively, and the rest only where the sandbox settles them, in their test
 * stablecoin, with the reason where it does not. On either tier a chain whose
 * links need deposit addresses (Arc) is available only while this deployment
 * issues them: the same rule the create applies (`evmPayLinkRefusal`).
 */
@Injectable()
export class PaymentNetworkCatalog {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly sandbox: SandboxDepositRoute,
    private readonly deposits: EvmDepositAddressFactory,
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
      if (isChain(id)) {
        const reason = this.nativeRefusal(id);
        return { ...base, available: reason === null, reason, asset: null };
      }
      if (tier === 'public') {
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

  /** Why a link on a natively settled chain cannot be created here, or null. */
  private nativeRefusal(id: PaymentNetwork): string | null {
    return isEvmChain(id)
      ? evmPayLinkRefusal(id, this.deposits.isEnabled(id))
      : null;
  }
}
