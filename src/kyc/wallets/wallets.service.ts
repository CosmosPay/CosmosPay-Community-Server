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
import { CreateWalletDto } from './dto/create-wallet.dto';

/**
 * Blockchain wallets belonging to a receiver — the on-chain endpoints for
 * onramp (mint destination) and offramp (funds source). Mirrored locally and
 * scoped to the consumer through the parent receiver.
 */
@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly receivers: ReceiversService,
  ) {}

  async create(
    consumer: GatewayConsumer,
    receiverId: string,
    dto: CreateWalletDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/blockchain-wallets`,
      ),
      dto,
    );
    return this.mirror(local.id, receiver.id, { ...dto, ...created });
  }

  async findAll(consumer: GatewayConsumer, receiverId: string) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const data = await this.prisma.blindpayBlockchainWallet.findMany({
      where: { receiverId: receiver.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  /** Returns the message the customer must sign for the secure (EOA) flow. */
  async signMessage(consumer: GatewayConsumer, receiverId: string) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    return this.blindpay.get<BlindpayObject>(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/blockchain-wallets/sign-message`,
      ),
    );
  }

  async remove(consumer: GatewayConsumer, receiverId: string, id: string) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const row = await this.prisma.blindpayBlockchainWallet.findFirst({
      where: { id, receiverId: receiver.id },
    });
    if (!row) {
      return { id, deleted: true };
    }
    await this.blindpay.delete(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/blockchain-wallets/${row.blindpayId}`,
      ),
    );
    await this.prisma.blindpayBlockchainWallet.delete({
      where: { id: row.id },
    });
    return { id, deleted: true };
  }

  private mirror(consumerId: string, receiverId: string, obj: BlindpayObject) {
    const data = {
      receiverId,
      name: asNullableString(obj.name),
      network: asNullableString(obj.network) ?? 'unknown',
      address: asNullableString(obj.address),
      isAccountAbstraction: Boolean(obj.is_account_abstraction),
      raw: toJson(obj),
    };
    return this.prisma.blindpayBlockchainWallet.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
    });
  }
}
