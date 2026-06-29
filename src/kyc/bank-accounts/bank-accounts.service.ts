import { Injectable } from '@nestjs/common';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { BlindpayClient } from '../../blindpay/blindpay.client';
import { ConsumerResolverService } from '../../blindpay/consumer-resolver.service';
import { BlindpayObject } from '../../blindpay/blindpay-sync.service';
import {
  asNullableString,
  asString,
  toJson,
} from '../../blindpay/blindpay.util';
import { ReceiversService } from '../receivers/receivers.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';

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
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/bank-accounts`,
      ),
      dto,
    );
    return this.mirror(local.id, receiver.id, { type: dto.type, ...created });
  }

  async findAll(consumer: GatewayConsumer, receiverId: string) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const data = await this.prisma.blindpayBankAccount.findMany({
      where: { receiverId: receiver.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
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
    });
  }
}
