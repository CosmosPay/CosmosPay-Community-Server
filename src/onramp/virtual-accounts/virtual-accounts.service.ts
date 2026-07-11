import { Injectable, NotFoundException } from '@nestjs/common';
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
import { ReceiversService } from '../../kyc/receivers/receivers.service';
import { CreateVirtualAccountDto } from '../dto/create-virtual-account.dto';

/**
 * Virtual accounts: dedicated fiat accounts in a receiver's name that auto-
 * convert deposits into stablecoin to a linked wallet. Mirrored locally and
 * scoped to the consumer via the receiver.
 */
@Injectable()
export class VirtualAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly receivers: ReceiversService,
  ) {}

  async create(
    consumer: GatewayConsumer,
    receiverId: string,
    dto: CreateVirtualAccountDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const walletBlindpayId = await this.resolveWalletBlindpayId(
      local.id,
      dto.blockchain_wallet_id,
    );
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/virtual-accounts`,
      ),
      { ...dto, blockchain_wallet_id: walletBlindpayId },
    );
    return this.mirror(local.id, receiver.id, created);
  }

  async findAll(consumer: GatewayConsumer, receiverId: string) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      receiverId,
    );
    const data = await this.prisma.blindpayVirtualAccount.findMany({
      where: { receiverId: receiver.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  private async resolveWalletBlindpayId(
    consumerId: string,
    localWalletId: string,
  ): Promise<string> {
    const wallet = await this.prisma.blindpayBlockchainWallet.findFirst({
      where: { id: localWalletId, consumerId },
    });
    if (!wallet) {
      throw new NotFoundException('Blockchain wallet not found');
    }
    return wallet.blindpayId;
  }

  private mirror(consumerId: string, receiverId: string, obj: BlindpayObject) {
    const data = {
      receiverId,
      blockchainWalletId: asNullableString(obj.blockchain_wallet_id),
      token: asNullableString(obj.token),
      status: asNullableString(obj.kyc_status) ?? asNullableString(obj.status),
      raw: toJson(obj),
    };
    return this.prisma.blindpayVirtualAccount.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
    });
  }
}
