import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import type {
  CreateP2pMarketPaymentMethodDto,
  QueryP2pMarketPaymentMethodsDto,
  UpdateP2pMarketPaymentMethodDto,
} from '@/p2p/dto/p2p-payment-method.dto';
import type { P2pMarketPaymentMethodEntity } from '@/p2p/entities/p2p-account.entity';
import type { P2pMarketPaymentDetailsEntity } from '@/p2p/entities/p2p-order.entity';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pDataCipher } from '@/p2p/p2p-data-cipher';
import {
  isP2pRailId,
  isPersonName,
  validateRailDetails,
} from '@/p2p/p2p-rails';
import {
  P2P_PAYMENT_METHOD_SELECT,
  toPaymentMethodView,
  type P2pPaymentMethodRow,
} from '@/p2p/p2p-views';

/**
 * Where an account receives local money. The details are checked per rail
 * (checksums included) and sealed at rest; the owner reads them back, and the
 * counterparty of a live order reads the ONE method that order names, through
 * {@link paymentDetailsOf}.
 */
@Injectable()
export class P2pPaymentMethodsService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: P2pAccountsService,
    private readonly cipher: P2pDataCipher,
    private readonly networks: P2pNetworksService,
  ) {}

  private view(row: P2pPaymentMethodRow): P2pMarketPaymentMethodEntity {
    return toPaymentMethodView(row, {
      details: this.cipher.open('payment-method.details', row.id, row.details),
      holderName: this.cipher.open(
        'payment-method.holder',
        row.id,
        row.holderName,
      ),
    });
  }

  private checked(rail: string, currency: string, details: unknown) {
    if (!isP2pRailId(rail)) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        `rail ${rail} is not a rail`,
      ]);
    }
    const check = validateRailDetails(rail, currency, details);
    if (!check.ok) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, check.errors);
    }
    return check.details;
  }

  private holder(name: string): string {
    const trimmed = name.trim();
    if (!isPersonName(trimmed)) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'holderName must be a person’s or a company’s name',
      ]);
    }
    return trimmed;
  }

  async create(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketPaymentMethodDto,
  ): Promise<P2pMarketPaymentMethodEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const account = await this.accounts.owned(consumerId, tier, dto.accountId);
    const details = this.checked(dto.rail, dto.currency, dto.details);
    const holderName = this.holder(dto.holderName);
    // The id is made here so the seal can bind to it.
    const id = randomUUID();
    const row = await this.prisma.p2pPaymentMethod.create({
      data: {
        id,
        accountId: account.id,
        consumerId,
        tier,
        currency: dto.currency,
        rail: dto.rail,
        details: this.cipher.seal('payment-method.details', id, details),
        holderName: this.cipher.seal('payment-method.holder', id, holderName),
        label: dto.label?.trim() || null,
      },
      select: P2P_PAYMENT_METHOD_SELECT,
    });
    return this.view(row);
  }

  async list(
    consumer: GatewayConsumer,
    query: QueryP2pMarketPaymentMethodsDto,
  ): Promise<Page<P2pMarketPaymentMethodEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      consumerId,
      tier,
      ...(query.accountId ? { accountId: query.accountId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pPaymentMethod.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_PAYMENT_METHOD_SELECT,
      }),
      this.prisma.p2pPaymentMethod.count({ where }),
    ]);
    return page(
      rows.map((r) => this.view(r)),
      total,
      query,
    );
  }

  private async owned(consumerId: string, tier: string, id: string) {
    const row = await this.prisma.p2pPaymentMethod.findFirst({
      where: { id, consumerId, tier },
      select: P2P_PAYMENT_METHOD_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P payment method ${id} not found`);
    return row;
  }

  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdateP2pMarketPaymentMethodDto,
  ): Promise<P2pMarketPaymentMethodEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    const data: Record<string, unknown> = {};
    if (dto.details !== undefined) {
      data.details = this.cipher.seal(
        'payment-method.details',
        row.id,
        this.checked(row.rail, row.currency, dto.details),
      );
    }
    if (dto.holderName !== undefined) {
      data.holderName = this.cipher.seal(
        'payment-method.holder',
        row.id,
        this.holder(dto.holderName),
      );
    }
    if (dto.label !== undefined) data.label = dto.label.trim() || null;
    if (dto.active !== undefined) data.active = dto.active;
    await this.prisma.p2pPaymentMethod.updateMany({
      where: { id: row.id, consumerId, tier },
      data,
    });
    return this.view(await this.owned(consumerId, tier, id));
  }

  async remove(consumer: GatewayConsumer, id: string): Promise<void> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    await this.prisma.p2pPaymentMethod.deleteMany({
      where: { id: row.id, consumerId, tier },
    });
  }

  /** An account's active method for a rail and currency, for matching a purchase. */
  async activeFor(
    accountId: string,
    rail: string,
    currency: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.p2pPaymentMethod.findFirst({
      where: { accountId, rail, currency, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  }

  /** Accounts among `accountIds` holding an active method for the rail and currency. */
  async accountsWithMethod(
    accountIds: string[],
    rail: string,
    currency: string,
  ): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const rows = await this.prisma.p2pPaymentMethod.findMany({
      where: { accountId: { in: accountIds }, rail, currency, active: true },
      select: { accountId: true },
    });
    return new Set(rows.map((r) => r.accountId));
  }

  /**
   * The details an order shows its payer: the ONE method the order names.
   * Callers decide whether the reader is entitled (the counterparty of a live
   * order); this only opens it. Null when the method was deleted.
   */
  async paymentDetailsOf(
    methodId: string | null,
  ): Promise<P2pMarketPaymentDetailsEntity | null> {
    if (!methodId) return null;
    const row = await this.prisma.p2pPaymentMethod.findUnique({
      where: { id: methodId },
      select: P2P_PAYMENT_METHOD_SELECT,
    });
    if (!row) return null;
    const view = this.view(row);
    return {
      rail: view.rail,
      holderName: view.holderName,
      details: view.details,
    };
  }
}
