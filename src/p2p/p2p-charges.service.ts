import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  CreateP2pMarketChargeDto,
  QueryP2pMarketChargesDto,
} from '@/p2p/dto/p2p-charge.dto';
import type { P2pMarketChargeEntity } from '@/p2p/entities/p2p-charge.entity';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { isUuid } from '@/p2p/p2p-order-ref';
import { fiatUnitsOf } from '@/p2p/p2p-quotes.service';
import { formatUnits } from '@/p2p/p2p-pricing';
import {
  P2P_CHARGE_SELECT,
  toChargeView,
  type P2pChargeRow,
  type P2pOrderRow,
} from '@/p2p/p2p-views';
import { P2pWebhooks } from '@/p2p/p2p-webhooks.service';
import { P2P_CURRENCIES, type P2pCurrency } from '@/p2p/p2p.constants';

/** A charge with no `expiresAt` is payable for a day. */
const DEFAULT_CHARGE_TTL_MS = 24 * 60 * 60 * 1000;
/** And never for more than 30 days. */
const MAX_CHARGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Charges (collections): an amount of local money a client's customer pays
 * on the hosted page, as a purchase whose tokens go to one of the client's
 * registered wallets. The payer's keyless half is `P2pCheckoutService`; this is
 * the client's (create, list, read, cancel) and the charge's own bookkeeping
 * when one of its orders completes.
 */
@Injectable()
export class P2pChargesService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: P2pAccountsService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
    private readonly webhooks: P2pWebhooks,
  ) {}

  private symbolOf(row: {
    tier: string;
    network: string;
    token: string;
  }): string {
    const d = this.networks.find(row.tier as StellarNetwork, row.network);
    return (
      d?.tokens.find((t) => t.address.toLowerCase() === row.token.toLowerCase())
        ?.symbol ?? row.token
    );
  }

  view(row: P2pChargeRow): P2pMarketChargeEntity {
    return toChargeView(
      row,
      this.symbolOf(row),
      this.config.get('p2p', { infer: true }).checkoutUrl,
      new Date(),
    );
  }

  async create(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketChargeDto,
  ): Promise<P2pMarketChargeEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const deployment = await this.reader.requireLive(tier, dto.network);
    const token = this.networks.token(deployment, dto.token);
    const recipient = await this.accounts.ownedByRef(
      consumerId,
      tier,
      dto.recipient,
    );
    const units = fiatUnitsOf(dto.currency, dto.fiatAmount);
    const now = Date.now();
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(now + DEFAULT_CHARGE_TTL_MS);
    if (
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > now + MAX_CHARGE_TTL_MS
    ) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'expiresAt must be in the future and at most 30 days away',
      ]);
    }
    const row = await this.prisma.p2pCharge.create({
      data: {
        id: randomUUID(),
        consumerId,
        tier,
        network: deployment.network,
        token: token.address,
        currency: dto.currency,
        fiatAmount: formatUnits(
          units,
          P2P_CURRENCIES[dto.currency as P2pCurrency].decimals,
        ),
        recipientAccountId: recipient.id,
        recipientAddress: recipient.address,
        description: dto.description?.trim() || null,
        multiUse: dto.multiUse ?? false,
        expiresAt,
      },
      select: P2P_CHARGE_SELECT,
    });
    return this.view(row);
  }

  async list(
    consumer: GatewayConsumer,
    query: QueryP2pMarketChargesDto,
  ): Promise<Page<P2pMarketChargeEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = { consumerId, tier };
    const [rows, total] = await Promise.all([
      this.prisma.p2pCharge.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_CHARGE_SELECT,
      }),
      this.prisma.p2pCharge.count({ where }),
    ]);
    return page(
      rows.map((r) => this.view(r)),
      total,
      query,
    );
  }

  private async owned(consumerId: string, tier: StellarNetwork, id: string) {
    const row = isUuid(id)
      ? await this.prisma.p2pCharge.findFirst({
          where: { id, consumerId, tier },
          select: P2P_CHARGE_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P charge ${id} not found`);
    return row;
  }

  async get(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<P2pMarketChargeEntity> {
    const tier = this.networks.tierFor(consumer);
    return this.view(
      await this.owned(await this.consumers.resolveId(consumer), tier, id),
    );
  }

  /**
   * Stops new orders on an open charge. An order already under way goes on:
   * its payer may have sent the money, and its completion still pays the
   * recipient (and is counted).
   */
  async cancel(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<P2pMarketChargeEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    if (row.status !== 'open') {
      throw ApiError.conflict(
        ApiErrorCode.RequestClosed,
        `P2P charge ${id} is ${row.status}: it can no longer be cancelled`,
      );
    }
    await this.prisma.p2pCharge.updateMany({
      where: { id: row.id, consumerId, tier, status: 'open' },
      data: { status: 'cancelled' },
    });
    return this.view(await this.owned(consumerId, tier, id));
  }

  /**
   * One of the charge's orders completed: count it, close a single-use charge
   * (a compare-and-swap on `open`, so a cancel racing it keeps `cancelled`)
   * and notify the client with `P2P_CHARGE_SUCCEEDED`, once per paying order.
   */
  async onOrderCompleted(order: P2pOrderRow): Promise<void> {
    if (!order.chargeId) return;
    const charge = await this.prisma.p2pCharge.update({
      where: { id: order.chargeId },
      data: { paidCount: { increment: 1 }, paidAt: new Date() },
      select: { ...P2P_CHARGE_SELECT, consumerId: true },
    });
    if (!charge.multiUse) {
      await this.prisma.p2pCharge.updateMany({
        where: { id: charge.id, status: 'open' },
        data: { status: 'paid' },
      });
    }
    const now = await this.prisma.p2pCharge.findUniqueOrThrow({
      where: { id: charge.id },
      select: P2P_CHARGE_SELECT,
    });
    await this.webhooks.chargeSucceeded(charge.consumerId, {
      ...this.view(now),
      orderId: order.id,
    });
  }
}
