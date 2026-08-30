import { Injectable, NotFoundException } from '@nestjs/common';
import { ConsumerResolverService } from '../blindpay/consumer-resolver.service';
import { formatFixed7, parseAmountOrZero } from '../common/stellar-amount';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

const STATS_BATCH_SIZE = 1_000;

type AssetTotal = {
  asset: string;
  assetIssuer: string | null;
  amount: bigint;
  succeeded: number;
};

type CustomerStats = {
  payments: number;
  totals: Map<string, AssetTotal>;
};

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumerResolver: ConsumerResolverService,
  ) {}

  async create(consumer: GatewayConsumer, dto: CreateCustomerDto) {
    const local = await this.consumerResolver.resolve(consumer);
    return this.prisma.customer.create({
      data: {
        consumerId: local.id,
        name: dto.name,
        alias: dto.alias ?? null,
        note: dto.note ?? null,
        email: dto.email ?? null,
        account: dto.account ?? null,
        reference: dto.reference ?? null,
      },
    });
  }

  async findAll(
    consumer: GatewayConsumer,
    query: QueryCustomersDto = new QueryCustomersDto(),
  ) {
    const local = await this.consumerResolver.resolve(consumer);
    const take = query.take ?? 20;
    const skip = query.skip ?? 0;
    const where = { consumerId: local.id };

    const [customers, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const accounts = [
      ...new Set(
        customers
          .map((customer) => customer.account)
          .filter((account): account is string => typeof account === 'string'),
      ),
    ];
    const stats = await this.loadStats(local.id, accounts);

    const data = customers.map((c) => {
      const customerStats = c.account ? stats.get(c.account) : undefined;
      const totals = [...(customerStats?.totals.values() ?? [])]
        .map(({ amount, ...assetTotal }) => ({
          ...assetTotal,
          amount: formatFixed7(amount),
        }))
        .sort(
          (a, b) =>
            a.asset.localeCompare(b.asset) ||
            (a.assetIssuer ?? '').localeCompare(b.assetIssuer ?? ''),
        );
      return {
        ...c,
        payments: customerStats?.payments ?? 0,
        totals,
      };
    });

    return { data, total, take, skip };
  }

  /**
   * Load only intents belonging to accounts on the current customer page. The
   * cursor keeps every Prisma read bounded while preserving exact all-time
   * totals for those accounts.
   */
  private async loadStats(
    consumerId: string,
    accounts: string[],
  ): Promise<Map<string, CustomerStats>> {
    const stats = new Map<string, CustomerStats>();
    if (accounts.length === 0) return stats;

    let cursor: string | undefined;
    for (;;) {
      const intents = await this.prisma.paymentIntent.findMany({
        where: { consumerId, source: { in: accounts } },
        select: {
          id: true,
          source: true,
          amount: true,
          status: true,
          asset: true,
          assetIssuer: true,
        },
        orderBy: { id: 'asc' },
        take: STATS_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const intent of intents) {
        if (!intent.source) continue;
        const customerStats = stats.get(intent.source) ?? {
          payments: 0,
          totals: new Map<string, AssetTotal>(),
        };
        customerStats.payments += 1;

        const asset =
          !intent.asset || intent.asset === 'native' ? 'XLM' : intent.asset;
        const assetIssuer = asset === 'XLM' ? null : intent.assetIssuer;
        const assetKey = JSON.stringify([asset, assetIssuer]);
        const assetTotal = customerStats.totals.get(assetKey) ?? {
          asset,
          assetIssuer,
          amount: 0n,
          succeeded: 0,
        };
        if (intent.status === 'SUCCEEDED') {
          assetTotal.succeeded += 1;
          assetTotal.amount += parseAmountOrZero(intent.amount);
        }
        customerStats.totals.set(assetKey, assetTotal);
        stats.set(intent.source, customerStats);
      }

      if (intents.length < STATS_BATCH_SIZE) break;
      cursor = intents[intents.length - 1].id;
    }

    return stats;
  }

  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.consumerResolver.resolve(consumer);
    const customer = await this.prisma.customer.findFirst({
      where: { id, consumerId: local.id },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async update(consumer: GatewayConsumer, id: string, dto: UpdateCustomerDto) {
    await this.findOne(consumer, id);
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.alias !== undefined ? { alias: dto.alias } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.account !== undefined ? { account: dto.account } : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
      },
    });
  }

  async remove(consumer: GatewayConsumer, id: string) {
    await this.findOne(consumer, id);
    await this.prisma.customer.delete({ where: { id } });
    return { id, deleted: true };
  }
}
