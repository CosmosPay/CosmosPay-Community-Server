import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VaultTransactionResponse } from '@defindex/sdk';
import { AppConfig } from '@/config/configuration';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import { DefindexClient } from '@/native-plugins/defindex/defindex.client';
import { DEFINDEX_DEFAULT_SLIPPAGE_BPS } from '@/native-plugins/defindex/defindex.constants';
import { DefindexTransactionsService } from '@/native-plugins/defindex/defindex-transactions.service';
import {
  DefindexDepositDto,
  DefindexWithdrawDto,
  defindexAmount,
} from '@/native-plugins/defindex/dto/defindex.dto';

/**
 * DeFindex vaults on the network of the caller's key: reads passed through,
 * and builds whose envelope is recorded before it is handed out, so the
 * submit relays only what was built here (`DefindexTransactionsService`).
 */
@Injectable()
export class DefindexService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: DefindexClient,
    private readonly transactions: DefindexTransactionsService,
  ) {}

  discover(consumer: GatewayConsumer) {
    return this.client.discoverVaults(resolveNetwork(this.config, consumer));
  }

  info(consumer: GatewayConsumer, vault: string) {
    return this.client.vaultInfo(resolveNetwork(this.config, consumer), vault);
  }

  balance(consumer: GatewayConsumer, vault: string, account: string) {
    return this.client.vaultBalance(
      resolveNetwork(this.config, consumer),
      vault,
      account,
    );
  }

  async deposit(
    consumer: GatewayConsumer,
    vault: string,
    dto: DefindexDepositDto,
  ): Promise<VaultTransactionResponse> {
    const network = resolveNetwork(this.config, consumer);
    // Converted before DeFindex is called: an amount the SDK's numbers cannot
    // hold is the caller's 400, never a provider error.
    const amounts = dto.amounts.map(defindexAmount);
    const invest = dto.invest ?? true;
    const slippageBps = dto.slippageBps ?? DEFINDEX_DEFAULT_SLIPPAGE_BPS;
    const built = await this.client.deposit(network, vault, {
      caller: dto.caller,
      amounts,
      invest,
      slippageBps,
    });
    await this.transactions.record(
      consumer,
      network,
      {
        kind: 'deposit',
        vault,
        caller: dto.caller,
        amounts: dto.amounts.map((amount) => BigInt(amount)),
        invest,
        slippageBps,
      },
      built,
    );
    return built;
  }

  async withdraw(
    consumer: GatewayConsumer,
    vault: string,
    dto: DefindexWithdrawDto,
  ): Promise<VaultTransactionResponse> {
    const network = resolveNetwork(this.config, consumer);
    const shares = defindexAmount(dto.shares);
    const slippageBps = dto.slippageBps ?? DEFINDEX_DEFAULT_SLIPPAGE_BPS;
    const built = await this.client.withdrawShares(network, vault, {
      caller: dto.caller,
      shares,
      slippageBps,
    });
    await this.transactions.record(
      consumer,
      network,
      {
        kind: 'withdraw',
        vault,
        caller: dto.caller,
        shares: BigInt(dto.shares),
        slippageBps,
      },
      built,
    );
    return built;
  }
}
