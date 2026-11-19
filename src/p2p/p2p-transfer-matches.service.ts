import { Injectable } from '@nestjs/common';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import type { P2pMarketTransferMatchesDto } from '@/p2p/dto/p2p-transaction.dto';
import type { P2pMarketTransferMatchEntity } from '@/p2p/entities/p2p-order.entity';
import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import { buildOrderAction } from '@/p2p/p2p-transaction-actions';
import { scoreTransfer } from '@/p2p/p2p-transfer-match';
import { fiatUnitsOf } from '@/p2p/p2p-quotes.service';
import { parseDecimalUnits } from '@/p2p/p2p-pricing';
import { P2P_ORDER_SELECT } from '@/p2p/p2p-views';
import {
  P2P_CURRENCIES,
  P2P_TRANSFER_MATCHES_LIMIT,
  type P2pCurrency,
} from '@/p2p/p2p.constants';

/** Candidates read per call: a merchant with more live orders than this in one amount is rare. */
const CANDIDATES = 50;

/**
 * The auto-release helper: a merchant's bot forwards each incoming bank
 * transfer and gets back the orders it most likely settles (the merchant's
 * live purchases and charges for that exact amount and currency), scored on
 * the payer's name and document, each with its `release` ready to sign. It
 * moves nothing: the bot decides and signs.
 */
@Injectable()
export class P2pTransferMatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly orders: P2pOrdersService,
    private readonly networks: P2pNetworksService,
  ) {}

  async match(
    consumer: GatewayConsumer,
    dto: P2pMarketTransferMatchesDto,
  ): Promise<{ data: P2pMarketTransferMatchEntity[] }> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const amount = fiatUnitsOf(dto.currency, dto.amount);
    const decimals = P2P_CURRENCIES[dto.currency as P2pCurrency].decimals;
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : null;
    const rows = await this.prisma.p2pOrder.findMany({
      where: {
        merchantConsumerId: consumerId,
        tier,
        kind: { in: ['BUY', 'CHARGE'] },
        status: { in: ['awaiting_payment', 'paid'] },
        currency: dto.currency,
        ...(receivedAt ? { createdAt: { lte: receivedAt } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: CANDIDATES,
      select: P2P_ORDER_SELECT,
    });
    const now = new Date();
    const matches: P2pMarketTransferMatchEntity[] = [];
    for (const row of rows) {
      if (parseDecimalUnits(row.fiatAmount, decimals) !== amount) continue;
      const view = await this.orders.merchantView(row);
      const release = buildOrderAction('release', {
        contract: row.contract,
        from: row.sellerAddress,
        order: row,
        now,
      });
      if (!release.ok) continue;
      matches.push({
        order: view,
        ...scoreTransfer(dto, view.payer),
        transaction: {
          chainId: view.chainId,
          value: '0',
          ...release.value,
        },
      });
    }
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        // A reported payment first: the person says this transfer is theirs.
        (a.order.status === 'paid' ? 0 : 1) -
          (b.order.status === 'paid' ? 0 : 1) ||
        a.order.createdAt.getTime() - b.order.createdAt.getTime(),
    );
    return { data: matches.slice(0, P2P_TRANSFER_MATCHES_LIMIT) };
  }
}
