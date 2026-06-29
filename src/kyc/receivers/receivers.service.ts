import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { BlindpayClient } from '../../blindpay/blindpay.client';
import { ConsumerResolverService } from '../../blindpay/consumer-resolver.service';
import {
  BlindpaySyncService,
  BlindpayObject,
} from '../../blindpay/blindpay-sync.service';
import type { BlindpayReceiver } from '../../../generated/prisma/client';
import { CreateReceiverDto } from './dto/create-receiver.dto';
import { UpdateReceiverDto } from './dto/update-receiver.dto';

/**
 * Manages BlindPay receivers (the KYC/KYB entities) on behalf of a consumer.
 * Creates/updates go to BlindPay and are mirrored locally; reads come from the
 * mirror, with single-receiver reads refreshed from BlindPay so the KYC status
 * is current. Every row is scoped to the calling consumer.
 */
@Injectable()
export class ReceiversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
  ) {}

  async create(consumer: GatewayConsumer, dto: CreateReceiverDto) {
    const local = await this.consumers.resolve(consumer);
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath('/customers'),
      dto,
    );
    return this.sync.mirrorReceiver(local.id, created);
  }

  async findAll(consumer: GatewayConsumer) {
    const local = await this.consumers.resolve(consumer);
    const data = await this.prisma.blindpayReceiver.findMany({
      where: { consumerId: local.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  /**
   * Reads a receiver, refreshing it from BlindPay so the caller sees the latest
   * KYC status. Falls back to the local mirror if the provider call fails.
   */
  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
      return await this.sync.mirrorReceiver(local.id, fresh);
    } catch {
      return row;
    }
  }

  async update(consumer: GatewayConsumer, id: string, dto: UpdateReceiverDto) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    const updated = await this.blindpay.put<BlindpayObject>(
      this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      dto,
    );
    // BlindPay PUT may return little; ensure we keep the id.
    return this.sync.mirrorReceiver(local.id, {
      id: row.blindpayId,
      ...updated,
    });
  }

  async remove(consumer: GatewayConsumer, id: string) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    await this.blindpay.delete(
      this.blindpay.instancePath(`/customers/${row.blindpayId}`),
    );
    await this.prisma.blindpayReceiver.delete({ where: { id: row.id } });
    return { id, deleted: true };
  }

  /**
   * Resolves a local receiver row for the consumer, or throws 404. Shared with
   * the wallet / bank-account / virtual-account services so a receiver id always
   * means "owned by this consumer".
   */
  async findReceiverOrThrow(
    consumerLocalId: string,
    id: string,
  ): Promise<BlindpayReceiver> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { id, consumerId: consumerLocalId },
    });
    if (!row) {
      throw new NotFoundException('Receiver not found');
    }
    return row;
  }
}
