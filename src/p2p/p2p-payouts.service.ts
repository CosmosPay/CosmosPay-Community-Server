import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  CreateP2pMarketPayoutDto,
  QueryP2pMarketPayoutsDto,
} from '@/p2p/dto/p2p-charge.dto';
import type { P2pMarketPayoutBatchEntity } from '@/p2p/entities/p2p-charge.entity';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOrderOpener } from '@/p2p/p2p-order-opener.service';
import {
  P2P_FINAL_STATUSES,
  type P2pOrderStatus,
} from '@/p2p/p2p-order-status';
import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import {
  P2pQuotesService,
  checkRail,
  fiatUnitsOf,
  windowsFor,
} from '@/p2p/p2p-quotes.service';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/p2p-views';
import { P2pWebhooks } from '@/p2p/p2p-webhooks.service';
import { P2P_PAYOUT_SETTLE_WINDOW_SECONDS } from '@/p2p/p2p.constants';

/** An item no merchant could take when its batch was created. */
export interface P2pFailedPayoutItem {
  index: number;
  currency: string;
  fiatAmount: string;
  externalReference: string | null;
  reason: string;
}

function failedItemsOf(value: unknown): P2pFailedPayoutItem[] {
  return Array.isArray(value) ? (value as P2pFailedPayoutItem[]) : [];
}

const BATCH_SELECT = {
  id: true,
  tier: true,
  network: true,
  token: true,
  accountId: true,
  status: true,
  itemCount: true,
  failedItems: true,
  completedAt: true,
  createdAt: true,
} as const;

/**
 * Payouts in local money from a client's balance in the contract. The client
 * registered the paying account, deposited tokens and authorised the matcher
 * (`setMatcher`, through `POST /v1/p2p/transactions`); each item is then
 * matched with a merchant that buys tokens and opened by the matcher on the
 * client's balance (the client sells, the merchant buys with a bond). The
 * merchant accepts, pays the beneficiary and marks the order paid; the client
 * releases it, or, if it allowed `autoSettle`, silence after six hours does.
 *
 * Items are opened one after another in the request; an item no merchant can
 * take right now is an order `failed` with its reason, never a hole in the
 * batch.
 */
@Injectable()
export class P2pPayoutsService {
  private readonly logger = new Logger(P2pPayoutsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: P2pAccountsService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
    private readonly quotes: P2pQuotesService,
    private readonly opener: P2pOrderOpener,
    private readonly orders: P2pOrdersService,
    private readonly webhooks: P2pWebhooks,
  ) {}

  async create(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketPayoutDto,
  ): Promise<P2pMarketPayoutBatchEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const account = dto.accountId
      ? await this.accounts.owned(consumerId, tier, dto.accountId)
      : await this.accounts.soleAccount(consumerId, tier, 'paying out');
    const deployment = await this.reader.requireLive(tier, dto.network);
    const token = this.networks.token(deployment, dto.token);
    const items = dto.items.map((item, i) => {
      checkRail(item.rail, item.currency);
      return {
        item,
        fiatUnits: fiatUnitsOf(item.currency, item.fiatAmount),
        beneficiary: this.orders.checkBeneficiary(
          item.beneficiary,
          item.rail,
          item.currency,
        ),
        index: i,
      };
    });
    const matcher = this.networks.matcherAddress();
    if (!matcher) {
      throw ApiError.misconfigured(
        'The P2P market cannot open payouts on this deployment right now.',
        'P2P_MATCHER_PRIVATE_KEY is not set.',
      );
    }
    const [terms, protocol] = await Promise.all([
      this.reader.matcherTerms(deployment, account.address, matcher, true),
      this.quotes.openProtocol(deployment),
    ]);
    if (terms.maxPerOrder === 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        'This account has not authorised the matcher on this network: send setMatcher first (POST /v1/p2p/transactions, action setMatcher).',
      );
    }
    const settleWindow = terms.autoSettle
      ? P2P_PAYOUT_SETTLE_WINDOW_SECONDS
      : 0;

    const batch = await this.prisma.p2pPayoutBatch.create({
      data: {
        consumerId,
        tier,
        network: deployment.network,
        token: token.address,
        accountId: account.id,
        sellerAddress: account.address,
        itemCount: items.length,
      },
      select: { id: true },
    });

    const failed: P2pFailedPayoutItem[] = [];
    const fail = (index: number, reason: string) => {
      const item = dto.items[index];
      failed.push({
        index,
        currency: item.currency,
        fiatAmount: item.fiatAmount,
        externalReference: item.externalReference?.trim() || null,
        reason,
      });
    };
    for (const { item, fiatUnits, beneficiary, index } of items) {
      const match = await this.quotes.match({
        deployment,
        token,
        side: 'SELL',
        currency: item.currency,
        rail: item.rail,
        fiatUnits,
        protocolFeeBps: protocol.feeBps,
        integratorFeeBps: 0,
        counterparty: account.address,
      });
      if (!match) {
        fail(index, 'no merchant could take it');
        continue;
      }
      if (match.amounts.grossTokens > terms.maxPerOrder) {
        fail(
          index,
          'it is above the per-order cap this account set for the matcher',
        );
        continue;
      }
      let written = false;
      try {
        const row = await this.opener.insert({
          id: randomUUID(),
          consumerId,
          kind: 'PAYOUT',
          deployment,
          token,
          match,
          currency: item.currency,
          rail: item.rail,
          sellerAddress: account.address,
          buyerAddress: match.account.address,
          openerAddress: matcher,
          windows: { ...windowsFor('SELL'), settleWindow },
          protocolFeeBps: protocol.feeBps,
          integratorFeeBps: 0,
          integratorAddress: null,
          payoutBatchId: batch.id,
          externalReference: item.externalReference?.trim() || null,
          beneficiary,
        });
        written = true;
        await this.opener.openViaMatcher(deployment, row);
      } catch (err) {
        // A merchant that filled up meanwhile (no order written), or an open
        // the opener already failed: either way the item did not open.
        this.logger.warn(
          `P2P payout batch ${batch.id}: item ${index} not opened: ${String(err)}`,
        );
        if (!written) fail(index, 'no merchant could take it');
      }
    }
    if (failed.length > 0) {
      await this.prisma.p2pPayoutBatch.update({
        where: { id: batch.id },
        data: { failedItems: failed as unknown as Prisma.InputJsonValue },
      });
    }
    await this.refresh(batch.id);
    return this.view(consumerId, tier, batch.id);
  }

  async list(
    consumer: GatewayConsumer,
    query: QueryP2pMarketPayoutsDto,
  ): Promise<Page<P2pMarketPayoutBatchEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = { consumerId, tier };
    const [rows, total] = await Promise.all([
      this.prisma.p2pPayoutBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: BATCH_SELECT,
      }),
      this.prisma.p2pPayoutBatch.count({ where }),
    ]);
    return page(
      rows.map((r) => ({
        ...r,
        failedItems: failedItemsOf(r.failedItems),
        orders: [],
      })),
      total,
      query,
    );
  }

  async get(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<P2pMarketPayoutBatchEntity> {
    const tier = this.networks.tierFor(consumer);
    return this.view(await this.consumers.resolveId(consumer), tier, id);
  }

  private async view(
    consumerId: string,
    tier: StellarNetwork,
    id: string,
  ): Promise<P2pMarketPayoutBatchEntity> {
    const batch = await this.prisma.p2pPayoutBatch.findFirst({
      where: { id, consumerId, tier },
      select: BATCH_SELECT,
    });
    if (!batch) throw ApiError.notFound(`P2P payout batch ${id} not found`);
    const orders = await this.prisma.p2pOrder.findMany({
      where: { payoutBatchId: id, consumerId, tier },
      orderBy: { createdAt: 'asc' },
      select: P2P_ORDER_SELECT,
    });
    return {
      ...batch,
      failedItems: failedItemsOf(batch.failedItems),
      orders: await Promise.all(
        orders.map((o) => this.orders.clientView(o, false)),
      ),
    };
  }

  /**
   * A batch is `processing` while any of its orders is live, then `completed`
   * (all completed), `failed` (none did) or `partially_completed`. Moves once
   * (compare-and-swap on `processing`) and notifies `P2P_PAYOUT_BATCH_COMPLETED`.
   */
  async refresh(batchId: string): Promise<void> {
    const batch = await this.prisma.p2pPayoutBatch.findUnique({
      where: { id: batchId },
      select: { ...BATCH_SELECT, consumerId: true },
    });
    if (!batch || batch.status !== 'processing') return;
    const orders = await this.prisma.p2pOrder.findMany({
      where: { payoutBatchId: batchId },
      select: { status: true },
    });
    const ended = orders.filter((o) =>
      P2P_FINAL_STATUSES.includes(o.status as P2pOrderStatus),
    );
    const failedItems = failedItemsOf(batch.failedItems);
    if (ended.length + failedItems.length < batch.itemCount) return;
    const completed = ended.filter((o) => o.status === 'completed').length;
    const status =
      completed === batch.itemCount
        ? 'completed'
        : completed === 0
          ? 'failed'
          : 'partially_completed';
    const moved = await this.prisma.p2pPayoutBatch.updateMany({
      where: { id: batchId, status: 'processing' },
      data: { status, completedAt: new Date() },
    });
    if (moved.count === 1) {
      await this.webhooks.payoutBatchCompleted(batch.consumerId, {
        id: batch.id,
        status,
        itemCount: batch.itemCount,
        completed,
        network: batch.network,
        token: batch.token,
        accountId: batch.accountId,
      });
    }
  }

  /** An order of a batch ended: the batch may have too. */
  async onOrderEnded(order: P2pOrderRow): Promise<void> {
    if (order.payoutBatchId) await this.refresh(order.payoutBatchId);
  }
}
