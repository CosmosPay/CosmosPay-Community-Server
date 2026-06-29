import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { BlindpayClient } from '../blindpay/blindpay.client';
import { ConsumerResolverService } from '../blindpay/consumer-resolver.service';
import {
  BlindpaySyncService,
  BlindpayObject,
} from '../blindpay/blindpay-sync.service';
import { asString } from '../blindpay/blindpay.util';
import { CreatePayinQuoteDto } from './dto/create-payin-quote.dto';
import { CreatePayinDto } from './dto/create-payin.dto';
import { CreateTrustlineDto } from './dto/create-trustline.dto';

/**
 * Onramp (fiat -> stablecoin). Quotes are priced through BlindPay and returned
 * as-is (ephemeral, ~5 min). Payins are created from a quote, mirrored locally
 * with their funding instructions, and attributed to the consumer. The customer
 * funds the payin off-platform; BlindPay confirms via webhook.
 */
@Injectable()
export class OnrampService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
  ) {}

  async createQuote(consumer: GatewayConsumer, dto: CreatePayinQuoteDto) {
    const local = await this.consumers.resolve(consumer);
    const walletBlindpayId = await this.resolveWalletBlindpayId(
      local.id,
      dto.blockchain_wallet_id,
    );
    return this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath('/payin-quotes'),
      { ...dto, blockchain_wallet_id: walletBlindpayId },
    );
  }

  async createPayin(consumer: GatewayConsumer, dto: CreatePayinDto) {
    const local = await this.consumers.resolve(consumer);
    // BlindPay exposes a single payin execution route (`/payins/evm`) for all
    // destination networks — the chain is determined by the quote's wallet.
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath('/payins/evm'),
      { payin_quote_id: dto.payin_quote_id },
    );
    const receiverId = await this.resolveReceiverLocalId(
      local.id,
      created.receiver_id,
    );
    return this.sync.mirrorPayin(local.id, receiverId, created);
  }

  async findAll(consumer: GatewayConsumer) {
    const local = await this.consumers.resolve(consumer);
    const data = await this.prisma.payin.findMany({
      where: { consumerId: local.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  /** Reads a payin, refreshing it from BlindPay so the status is current. */
  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.prisma.payin.findFirst({
      where: { id, consumerId: local.id },
    });
    if (!row) {
      throw new NotFoundException('Payin not found');
    }
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/payins/${row.blindpayId}`),
      );
      return await this.sync.mirrorPayin(local.id, row.receiverId, fresh);
    } catch {
      return row;
    }
  }

  /** Builds an unsigned Stellar trustline tx (XDR) for the customer to sign. */
  async createTrustline(consumer: GatewayConsumer, dto: CreateTrustlineDto) {
    await this.consumers.resolve(consumer);
    return this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath('/create-asset-trustline'),
      { address: dto.address },
    );
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

  private async resolveReceiverLocalId(
    consumerId: string,
    receiverBlindpayId: unknown,
  ): Promise<string | null> {
    if (!receiverBlindpayId) return null;
    const receiver = await this.prisma.blindpayReceiver.findFirst({
      where: { consumerId, blindpayId: asString(receiverBlindpayId) },
    });
    return receiver?.id ?? null;
  }
}
