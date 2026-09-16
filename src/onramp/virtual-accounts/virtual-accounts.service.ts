import { Injectable } from '@nestjs/common';
import { ApiError } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { page } from '@/common/pagination';
import { PrismaService } from '@/prisma/prisma.service';
import { BlindpayOnrampApi } from '@/blindpay/blindpay-onramp.api';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  BlindpayObject,
  VIRTUAL_ACCOUNT_PUBLIC_SELECT,
} from '@/blindpay/blindpay-sync.service';
import { asNullableString, asString, toJson } from '@/blindpay/blindpay.util';
import type { BlindpayEnvironment } from '@/config/configuration';
import { ReceiversService } from '@/kyc/receivers/receivers.service';
import { CreateVirtualAccountDto } from '@/onramp/dto/create-virtual-account.dto';

/**
 * Virtual accounts: dedicated fiat accounts in a receiver's name that auto-
 * convert deposits into stablecoin to a linked wallet. Mirrored locally and
 * scoped to the consumer via the receiver, which also pins them to the caller's
 * BlindPay instance.
 */
@Injectable()
export class VirtualAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayOnrampApi,
    private readonly consumers: ConsumerResolverService,
    private readonly receivers: ReceiversService,
  ) {}

  async create(
    consumer: GatewayConsumer,
    receiverId: string,
    dto: CreateVirtualAccountDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const environment = this.blindpay.environmentFor(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      environment,
      receiverId,
    );
    // A virtual account is a standing deposit rail in this receiver's name, so
    // the kill switch applies here exactly as it does to adding a wallet or a
    // bank account. It was the one fiat operation that skipped it: an operator
    // disabled an account and the same key could still open a new way to fund it.
    this.receivers.assertEnabled(receiver);
    const walletBlindpayId = await this.resolveWalletBlindpayId(
      local.id,
      environment,
      dto.blockchain_wallet_id,
    );
    const created = await this.blindpay.createVirtualAccount(
      environment,
      receiver.blindpayId,
      { ...dto, blockchain_wallet_id: walletBlindpayId },
    );
    return this.mirror(local.id, environment, receiver.id, created);
  }

  async findAll(
    consumer: GatewayConsumer,
    receiverId: string,
    query: PaginationQueryDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const receiver = await this.receivers.findReceiverOrThrow(
      local.id,
      this.blindpay.environmentFor(consumer),
      receiverId,
    );
    const where = { receiverId: receiver.id };
    // `total` is the row count, not the page length. Returning `data.length`
    // made the field useless: it always equalled what the caller just received,
    // so nobody could tell a full page from the last one.
    const [data, total] = await Promise.all([
      this.prisma.blindpayVirtualAccount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: VIRTUAL_ACCOUNT_PUBLIC_SELECT,
      }),
      this.prisma.blindpayVirtualAccount.count({ where }),
    ]);
    return page(data, total, query);
  }

  private async resolveWalletBlindpayId(
    consumerId: string,
    environment: BlindpayEnvironment,
    localWalletId: string,
  ): Promise<string> {
    const wallet = await this.prisma.blindpayBlockchainWallet.findFirst({
      where: { id: localWalletId, consumerId, environment },
    });
    if (!wallet) {
      throw ApiError.notFound('Blockchain wallet not found');
    }
    // The destination wallet may belong to another of this consumer's
    // receivers. A disabled one must not become the landing account either —
    // the rule onramp already applies to the same wallet.
    const owner = await this.prisma.blindpayReceiver.findUnique({
      where: { id: wallet.receiverId },
      select: { disabled: true },
    });
    if (owner) {
      this.receivers.assertEnabled(owner);
    }
    return wallet.blindpayId;
  }

  private mirror(
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverId: string,
    obj: BlindpayObject,
  ) {
    const data = {
      receiverId,
      blockchainWalletId: asNullableString(obj.blockchain_wallet_id),
      token: asNullableString(obj.token),
      status: asNullableString(obj.kyc_status) ?? asNullableString(obj.status),
      raw: toJson(obj),
    };
    // Narrowed for the same reason as `mirrorPayin`: this upsert's return value
    // IS the create response. Without the `select` it carried `raw` — the
    // provider payload whole — straight out, while `findAll` next to it already
    // kept the blob in PostgreSQL.
    return this.prisma.blindpayVirtualAccount.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: {
        consumerId,
        environment,
        blindpayId: asString(obj.id),
        ...data,
      },
      update: data,
      select: VIRTUAL_ACCOUNT_PUBLIC_SELECT,
    });
  }
}
