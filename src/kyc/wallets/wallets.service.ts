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
import { CreateWalletDto } from './dto/create-wallet.dto';

/**
 * The columns a wallet is allowed to leave this service with — the exact field list of
 * `WalletEntity`. `raw` (the provider object) is deliberately absent so the read paths
 * cannot emit a field the documented contract does not have; it is kept in the mirror
 * for provider round-trips only.
 */
export const WALLET_PUBLIC_SELECT = {
  id: true,
  blindpayId: true,
  name: true,
  network: true,
  address: true,
  isAccountAbstraction: true,
  createdAt: true,
} as const satisfies Prisma.BlindpayBlockchainWalletSelect;

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
    this.receivers.assertEnabled(receiver);
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(
        `/customers/${receiver.blindpayId}/blockchain-wallets`,
      ),
      dto,
    );
    return this.mirror(local.id, receiver.id, { ...dto, ...created });
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
      this.prisma.blindpayBlockchainWallet.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: WALLET_PUBLIC_SELECT,
      }),
      this.prisma.blindpayBlockchainWallet.count({ where }),
    ]);
    return page(data, total, query);
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
      // The create response is a read path too — keep the provider blob out of it.
      select: WALLET_PUBLIC_SELECT,
    });
  }
}
