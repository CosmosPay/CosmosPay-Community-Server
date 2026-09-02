import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { PaginationQueryDto } from '../../common/dto/pagination.query.dto';
import { page } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { BlindpayClient } from '../../blindpay/blindpay.client';
import { ConsumerResolverService } from '../../common/services/consumer-resolver.service';
import { BlindpayObject } from '../../blindpay/blindpay-sync.service';
import {
  asNullableString,
  asString,
  toJson,
} from '../../blindpay/blindpay.util';
import { ReceiversService } from '../receivers/receivers.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';

/**
 * The columns a bank account is allowed to leave this service with — the exact field
 * list of `BankAccountEntity`.
 *
 * As with the receiver dossier, `raw` is deliberately absent: it is the provider object,
 * which for a bank account mirrors the account credentials themselves (IBAN, CLABE,
 * routing/account number, CPF/CNPJ, beneficiary address). The mirror keeps it for
 * provider round-trips; the API returns the identifiers only.
 */
export const BANK_ACCOUNT_PUBLIC_SELECT = {
  id: true,
  blindpayId: true,
  rail: true,
  name: true,
  country: true,
  createdAt: true,
} as const satisfies Prisma.BlindpayBankAccountSelect;

/**
 * Fiat bank accounts belonging to a receiver — the settlement destination for
 * offramp payouts. Mirrored locally and scoped to the consumer via the receiver.
 */
@Injectable()
export class BankAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly receivers: ReceiversService,
  ) {}

  async create(
    consumer: GatewayConsumer,
    receiverId: string,
    dto: CreateBankAccountDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    this.receivers.assertEnabled(receiver);
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/bank-accounts`,
      ),
      dto,
    );
    return this.mirror(local.id, receiver.id, { type: dto.type, ...created });
  }

  async findAll(
    consumer: GatewayConsumer,
    receiverId: string,
    query: PaginationQueryDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const where = { receiverId: receiver.id };
    // `total` is the row count, not the page length (see ReceiversService.findAll).
    const [data, total] = await Promise.all([
      this.prisma.blindpayBankAccount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: BANK_ACCOUNT_PUBLIC_SELECT,
      }),
      this.prisma.blindpayBankAccount.count({ where }),
    ]);
    return page(data, total, query);
  }

  async remove(consumer: GatewayConsumer, receiverId: string, id: string) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const row = await this.prisma.blindpayBankAccount.findFirst({
      where: { id, receiverId: receiver.id },
    });
    if (!row) {
      return { id, deleted: true };
    }
    await this.blindpay.delete(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/bank-accounts/${row.blindpayId}`,
      ),
    );
    await this.prisma.blindpayBankAccount.delete({ where: { id: row.id } });
    return { id, deleted: true };
  }

  private mirror(consumerId: string, receiverId: string, obj: BlindpayObject) {
    const data = {
      receiverId,
      rail: asNullableString(obj.type),
      name: asNullableString(obj.name),
      country: asNullableString(obj.country),
      raw: toJson(obj),
    };
    return this.prisma.blindpayBankAccount.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
      // The create response is a read path too — don't echo the stored credentials back.
      select: BANK_ACCOUNT_PUBLIC_SELECT,
    });
  }
}
