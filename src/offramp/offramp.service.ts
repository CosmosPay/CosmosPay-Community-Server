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
import type { Payout } from '../../generated/prisma/client';
import { CreatePayoutQuoteDto } from './dto/create-payout-quote.dto';
import { AuthorizePayoutDto } from './dto/authorize-payout.dto';
import { CreatePayoutDto } from './dto/create-payout.dto';
import { PayoutDocumentDto } from './dto/payout-document.dto';

/**
 * Offramp (stablecoin -> fiat). Quotes are priced through BlindPay (the EVM quote
 * carries the `approve` contract the customer signs). The customer signs the
 * on-chain transfer — the service never holds keys: for Stellar/Solana it returns
 * the unsigned tx via {@link authorize} and accepts the signed one back on create.
 * Payouts are mirrored locally and BlindPay confirms settlement via webhook.
 */
@Injectable()
export class OfframpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
  ) {}

  async createQuote(consumer: GatewayConsumer, dto: CreatePayoutQuoteDto) {
    const local = await this.consumers.resolve(consumer);
    const bankAccountBlindpayId = await this.resolveBankAccountBlindpayId(
      local.id,
      dto.bank_account_id,
    );
    return this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath('/quotes'),
      { ...dto, bank_account_id: bankAccountBlindpayId },
    );
  }

  /** Step 1 for Stellar/Solana: returns the unsigned tx for the customer to sign. */
  async authorize(consumer: GatewayConsumer, dto: AuthorizePayoutDto) {
    await this.consumers.resolve(consumer);
    return this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(`/payouts/${dto.chain}/authorize`),
      {
        quote_id: dto.quote_id,
        sender_wallet_address: dto.sender_wallet_address,
      },
    );
  }

  async createPayout(consumer: GatewayConsumer, dto: CreatePayoutDto) {
    const local = await this.consumers.resolve(consumer);
    const body: Record<string, unknown> = {
      quote_id: dto.quote_id,
      sender_wallet_address: dto.sender_wallet_address,
    };
    if (dto.signed_transaction !== undefined) {
      body.signed_transaction = dto.signed_transaction;
    }
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(`/payouts/${dto.chain}`),
      body,
    );
    const receiverId = await this.resolveReceiverLocalId(
      local.id,
      created.receiver_id,
    );
    return this.sync.mirrorPayout(local.id, receiverId, created);
  }

  async findAll(consumer: GatewayConsumer) {
    const local = await this.consumers.resolve(consumer);
    const data = await this.prisma.payout.findMany({
      where: { consumerId: local.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  /** Reads a payout, refreshing it from BlindPay so the status is current. */
  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findPayoutOrThrow(local.id, id);
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/payouts/${row.blindpayId}`),
      );
      return await this.sync.mirrorPayout(local.id, row.receiverId, fresh);
    } catch {
      return row;
    }
  }

  async addDocument(
    consumer: GatewayConsumer,
    id: string,
    dto: PayoutDocumentDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findPayoutOrThrow(local.id, id);
    return this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath(`/payouts/${row.blindpayId}/documents`),
      dto,
    );
  }

  private async findPayoutOrThrow(
    consumerId: string,
    id: string,
  ): Promise<Payout> {
    const row = await this.prisma.payout.findFirst({
      where: { id, consumerId },
    });
    if (!row) {
      throw new NotFoundException('Payout not found');
    }
    return row;
  }

  private async resolveBankAccountBlindpayId(
    consumerId: string,
    localId: string,
  ): Promise<string> {
    const account = await this.prisma.blindpayBankAccount.findFirst({
      where: { id: localId, consumerId },
    });
    if (!account) {
      throw new NotFoundException('Bank account not found');
    }
    return account.blindpayId;
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
