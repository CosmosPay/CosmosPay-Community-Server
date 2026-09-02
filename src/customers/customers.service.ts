import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { formatNumericAmount } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

/** On-chain activity attributed to a customer's Stellar account. */
interface CustomerPaymentStats {
  payments: number;
  succeeded: number;
  /** Settled volume as a decimal string — never a float. */
  total: string;
}

const NO_ACTIVITY: CustomerPaymentStats = {
  payments: 0,
  succeeded: 0,
  total: '0',
};

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  private resolveConsumer(consumer: GatewayConsumer) {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  async create(consumer: GatewayConsumer, dto: CreateCustomerDto) {
    const local = await this.resolveConsumer(consumer);
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

  async findAll(consumer: GatewayConsumer, query: QueryCustomersDto) {
    const local = await this.resolveConsumer(consumer);
    const where = { consumerId: local.id };

    // `total` is the row count, never `data.length` — the page size is `take`
    // on every full page, so a client paginating on it never sees the end.
    const [customers, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const stats = await this.paymentStats(
      local.id,
      customers
        .map((c) => c.account)
        .filter((account): account is string => Boolean(account)),
    );

    const data = customers.map((c) => {
      const s = (c.account && stats.get(c.account)) || NO_ACTIVITY;
      return {
        ...c,
        payments: s.payments,
        succeeded: s.succeeded,
        total: s.total,
      };
    });

    return { data, total, take: query.take, skip: query.skip };
  }

  /**
   * Per-account payment stats for the accounts on the current page, aggregated
   * in PostgreSQL.
   *
   * This used to load every customer *and* every payment intent belonging to
   * the consumer on each request and tally them in JS: two unbounded reads to
   * produce three numbers per row, growing with the merchant's whole history.
   *
   * The counts alone would be a `groupBy`, but the settled volume cannot go
   * through `_sum`: `PaymentIntent.amount` is a `String` column (decimal
   * strings, so Stellar's 7-dp values stay exact) and Prisma will not sum text.
   * So the aggregate is one `$queryRaw` with a `::numeric` cast — which also
   * makes the money *more* accurate than the previous `Number(...)`
   * accumulation, which rounded in binary floating point. Values are
   * parameterized; the account list is bounded by the page size.
   */
  private async paymentStats(
    consumerId: string,
    accounts: string[],
  ): Promise<Map<string, CustomerPaymentStats>> {
    if (accounts.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<
      { account: string; payments: bigint; succeeded: bigint; total: unknown }[]
    >`
      SELECT "source" AS account,
             COUNT(*) AS payments,
             COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED') AS succeeded,
             COALESCE(
               SUM(NULLIF("amount", '')::numeric)
                 FILTER (WHERE "status" = 'SUCCEEDED'),
               0
             ) AS total
        FROM "payment_intent"
       WHERE "consumerId" = ${consumerId}
         AND "source" IN (${Prisma.join(accounts)})
       GROUP BY "source"
    `;

    return new Map(
      rows.map((r) => [
        r.account,
        {
          payments: Number(r.payments),
          succeeded: Number(r.succeeded),
          total: formatNumericAmount(r.total),
        },
      ]),
    );
  }

  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.resolveConsumer(consumer);
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
