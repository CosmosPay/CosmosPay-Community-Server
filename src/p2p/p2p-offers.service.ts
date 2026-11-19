import { Injectable } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  CreateP2pMarketOfferDto,
  QueryP2pMarketOffersDto,
  UpdateP2pMarketOfferDto,
} from '@/p2p/dto/p2p-offer.dto';
import type { P2pMarketOfferEntity } from '@/p2p/entities/p2p-offer.entity';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { parseDecimalUnits } from '@/p2p/p2p-pricing';
import { P2P_RAILS, isP2pRailId } from '@/p2p/p2p-rails';
import {
  P2P_OFFER_SELECT,
  toOfferView,
  type P2pOfferRow,
} from '@/p2p/p2p-views';
import {
  P2P_CURRENCIES,
  P2P_DEFAULT_PRICE_TTL_SECONDS,
  P2P_PRICE_DECIMALS,
  type P2pCurrency,
} from '@/p2p/p2p.constants';

/**
 * Merchants' standing prices. An offer is the merchant's word on a price and
 * its limits; whether it can be filled right now (liquidity, open orders,
 * a fresh price) is decided at match time, never here.
 */
@Injectable()
export class P2pOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: P2pAccountsService,
    private readonly networks: P2pNetworksService,
  ) {}

  private symbolOf(tier: StellarNetwork, row: P2pOfferRow): string {
    const d = this.networks.find(tier, row.network);
    return (
      d?.tokens.find((t) => t.address.toLowerCase() === row.token.toLowerCase())
        ?.symbol ?? row.token
    );
  }

  private view(tier: StellarNetwork, row: P2pOfferRow): P2pMarketOfferEntity {
    return toOfferView(row, this.symbolOf(tier, row), new Date());
  }

  /** Checks price and bounds together: a positive price, min ≤ max, both within the currency's decimals. */
  private checkTerms(
    currency: string,
    terms: { price: string; minFiat: string; maxFiat: string },
  ): void {
    const errors: string[] = [];
    const decimals = P2P_CURRENCIES[currency as P2pCurrency].decimals;
    const price = parseDecimalUnits(terms.price, P2P_PRICE_DECIMALS);
    const min = parseDecimalUnits(terms.minFiat, decimals);
    const max = parseDecimalUnits(terms.maxFiat, decimals);
    if (price === null || price <= 0n)
      errors.push('price must be greater than 0');
    if (min === null)
      errors.push(`minFiat takes at most ${decimals} decimals in ${currency}`);
    if (max === null)
      errors.push(`maxFiat takes at most ${decimals} decimals in ${currency}`);
    if (min !== null && max !== null && (min <= 0n || min > max)) {
      errors.push('minFiat must be greater than 0 and at most maxFiat');
    }
    if (errors.length)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, errors);
  }

  private checkRails(currency: string, rails: string[]): void {
    const wrong = rails.filter(
      (r) => !isP2pRailId(r) || P2P_RAILS[r].currency !== currency,
    );
    if (wrong.length) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        `rails ${wrong.join(', ')} do not pay in ${currency}`,
      ]);
    }
  }

  async create(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketOfferDto,
  ): Promise<P2pMarketOfferEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const account = await this.accounts.owned(consumerId, tier, dto.accountId);
    if (!account.displayName) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'the account needs a displayName before it can publish an offer (PATCH /v1/p2p/accounts/{id})',
      ]);
    }
    const deployment = this.networks.require(tier, dto.network);
    const token = this.networks.token(deployment, dto.token);
    this.checkRails(dto.currency, dto.rails);
    this.checkTerms(dto.currency, dto);
    const row = await this.prisma.p2pOffer.create({
      data: {
        accountId: account.id,
        consumerId,
        tier,
        side: dto.side,
        network: deployment.network,
        token: token.address,
        currency: dto.currency,
        rails: [...new Set(dto.rails)],
        price: dto.price,
        priceUpdatedAt: new Date(),
        priceTtlSeconds: dto.priceTtlSeconds ?? P2P_DEFAULT_PRICE_TTL_SECONDS,
        minFiat: dto.minFiat,
        maxFiat: dto.maxFiat,
        active: dto.active ?? true,
      },
      select: P2P_OFFER_SELECT,
    });
    return this.view(tier, row);
  }

  async list(
    consumer: GatewayConsumer,
    query: QueryP2pMarketOffersDto,
  ): Promise<Page<P2pMarketOfferEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      consumerId,
      tier,
      ...(query.accountId ? { accountId: query.accountId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOffer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_OFFER_SELECT,
      }),
      this.prisma.p2pOffer.count({ where }),
    ]);
    return page(
      rows.map((r) => this.view(tier, r)),
      total,
      query,
    );
  }

  private async owned(consumerId: string, tier: string, id: string) {
    const row = await this.prisma.p2pOffer.findFirst({
      where: { id, consumerId, tier },
      select: P2P_OFFER_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P offer ${id} not found`);
    return row;
  }

  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdateP2pMarketOfferDto,
  ): Promise<P2pMarketOfferEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    if (dto.rails) this.checkRails(row.currency, dto.rails);
    this.checkTerms(row.currency, {
      price: dto.price ?? row.price,
      minFiat: dto.minFiat ?? row.minFiat,
      maxFiat: dto.maxFiat ?? row.maxFiat,
    });
    await this.prisma.p2pOffer.updateMany({
      where: { id: row.id, consumerId, tier },
      data: {
        ...(dto.price !== undefined
          ? { price: dto.price, priceUpdatedAt: new Date() }
          : {}),
        ...(dto.priceTtlSeconds !== undefined
          ? { priceTtlSeconds: dto.priceTtlSeconds }
          : {}),
        ...(dto.rails ? { rails: [...new Set(dto.rails)] } : {}),
        ...(dto.minFiat !== undefined ? { minFiat: dto.minFiat } : {}),
        ...(dto.maxFiat !== undefined ? { maxFiat: dto.maxFiat } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return this.view(tier, await this.owned(consumerId, tier, id));
  }

  async remove(consumer: GatewayConsumer, id: string): Promise<void> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    await this.prisma.p2pOffer.deleteMany({
      where: { id: row.id, consumerId, tier },
    });
  }

  /** Whether the account publishes an active offer selling tokens (a liquidity merchant). */
  async sellsLiquidity(accountId: string): Promise<boolean> {
    return (
      (await this.prisma.p2pOffer.count({
        where: { accountId, side: 'SELL_TOKEN', active: true },
      })) > 0
    );
  }
}
