import { Injectable } from '@nestjs/common';
import { toChecksumAddress } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type { BuildP2pMarketTransactionDto } from '@/p2p/dto/p2p-transaction.dto';
import type { P2pMarketTransactionEntity } from '@/p2p/entities/p2p-transaction.entity';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOffersService } from '@/p2p/p2p-offers.service';
import { isUuid } from '@/p2p/p2p-order-ref';
import {
  buildBalanceAction,
  buildOrderAction,
  isBalanceAction,
  type P2pTransactionAction,
} from '@/p2p/p2p-transaction-actions';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/p2p-views';

/**
 * Builds the transactions clients and their bots sign: one action table
 * (`p2p-transaction-actions.ts`) and the facts each action reads. `from` is
 * one of the caller's accounts, or the seller's address of one of the
 * caller's sales (a person's wallet is not an account). An order action names
 * an order the caller is a party to: its client (it created it) or its
 * merchant (its account is the merchant). Nothing is signed here.
 */
@Injectable()
export class P2pTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: P2pAccountsService,
    private readonly offers: P2pOffersService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
  ) {}

  async build(
    consumer: GatewayConsumer,
    dto: BuildP2pMarketTransactionDto,
  ): Promise<P2pMarketTransactionEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const deployment = await this.reader.requireLive(tier, dto.network);
    const action = dto.action as P2pTransactionAction;
    const args = dto.args ?? {};

    if (isBalanceAction(action)) {
      const account = await this.accounts.ownedByRef(
        consumerId,
        tier,
        dto.from,
      );
      const built = buildBalanceAction(action, args, {
        contract: deployment.contract,
        from: account.address,
        matcher: this.networks.matcherAddress(),
        token: (value) => {
          try {
            return this.networks.token(deployment, value);
          } catch {
            return null;
          }
        },
        sellsLiquidity:
          action === 'setMatcher'
            ? await this.offers.sellsLiquidity(account.id)
            : false,
      });
      if (!built.ok) {
        throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [built.error]);
      }
      return { chainId: deployment.chainId, value: '0', ...built.value };
    }

    const orderId = args.orderId;
    if (typeof orderId !== 'string' || !isUuid(orderId)) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'args.orderId must be the id of an order',
      ]);
    }
    const order = await this.partyOrder(consumerId, tier, orderId);
    if (order.network !== deployment.network) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        `the order is on ${order.network}, not ${deployment.network}`,
      ]);
    }
    const from = await this.signer(consumerId, tier, dto.from, order);
    const built = buildOrderAction(action, {
      contract: order.contract,
      from,
      order,
      now: new Date(),
    });
    if (!built.ok) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        built.error,
      );
    }
    return { chainId: deployment.chainId, value: '0', ...built.value };
  }

  /** An order the caller created or is the merchant of, on its tier; else a 404. */
  async partyOrder(
    consumerId: string,
    tier: StellarNetwork,
    id: string,
  ): Promise<P2pOrderRow> {
    const row = await this.prisma.p2pOrder.findFirst({
      where: {
        id,
        tier,
        OR: [{ consumerId }, { merchantConsumerId: consumerId }],
      },
      select: P2P_ORDER_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return row;
  }

  /**
   * The wallet that signs: an account of the caller (by id or address), or
   * the seller's address of a sale the caller created, for that order only.
   */
  private async signer(
    consumerId: string,
    tier: StellarNetwork,
    from: string,
    order: P2pOrderRow,
  ): Promise<string> {
    if (
      order.kind === 'SELL' &&
      order.consumerId === consumerId &&
      /^0x[0-9a-fA-F]{40}$/.test(from) &&
      toChecksumAddress(from) === order.sellerAddress
    ) {
      return order.sellerAddress;
    }
    const account = await this.accounts.ownedByRef(consumerId, tier, from);
    return account.address;
  }
}
