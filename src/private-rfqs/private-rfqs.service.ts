import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import type {
  Prisma,
  PrivateRfq,
  PrivateRfqStatus,
} from '@generated/prisma/client';
import { CreatePrivateRfqDto } from '@/private-rfqs/dto/create-private-rfq.dto';
import { CreateRfqPaymentIntentDto } from '@/private-rfqs/dto/create-rfq-payment-intent.dto';
import { QueryPrivateRfqsDto } from '@/private-rfqs/dto/query-private-rfqs.dto';
import {
  privateRfqItemRef,
  privateRfqMemo,
} from '@/private-rfqs/private-rfq-reference';
import {
  SubRosaRoundReadError,
  SubRosaRoundReader,
  type SubRosaRoundSnapshot,
} from '@/private-rfqs/sub-rosa-round-reader.service';

export const PRIVATE_RFQ_PUBLIC_SELECT = {
  id: true,
  reference: true,
  network: true,
  contractId: true,
  roundId: true,
  status: true,
  roundStatus: true,
  commitDeadline: true,
  revealDeadline: true,
  assetCode: true,
  assetIssuer: true,
  assetDecimals: true,
  selectedProvider: true,
  selectedAmount: true,
  selectedAt: true,
  revealedAt: true,
  paymentIntentId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PrivateRfqSelect;

export type PublicPrivateRfq = Prisma.PrivateRfqGetPayload<{
  select: typeof PRIVATE_RFQ_PUBLIC_SELECT;
}>;

export type PrivateRfqView = PublicPrivateRfq & {
  quotes?: SubRosaRoundSnapshot['quotes'];
};

@Injectable()
export class PrivateRfqsService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly rounds: SubRosaRoundReader,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly paymentIntents: PaymentIntentsService,
  ) {}

  async create(
    consumer: GatewayConsumer,
    dto: CreatePrivateRfqDto,
  ): Promise<PrivateRfqView> {
    this.assertConsumerNetwork(consumer, dto.network);
    this.assertAsset(dto.assetCode ?? 'native', dto.assetIssuer);
    const reference = dto.reference.trim();
    const snapshot = await this.readRegistration(dto);
    this.assertRound(reference, snapshot);
    const localConsumer = await this.consumers.resolve(consumer);

    let created: PrivateRfq;
    try {
      created = await this.prisma.privateRfq.create({
        data: {
          consumerId: localConsumer.id,
          reference,
          network: dto.network,
          contractId: dto.contractId,
          roundId: dto.roundId,
          status: this.statusOf(snapshot),
          roundStatus: snapshot.roundStatus,
          commitDeadline: this.dateFromSeconds(snapshot.commitDeadline),
          revealDeadline: this.dateFromSeconds(snapshot.revealDeadline),
          assetCode: dto.assetCode ?? 'native',
          assetIssuer: dto.assetIssuer,
          assetDecimals: dto.assetDecimals ?? 7,
          ...(snapshot.revealComplete ? { revealedAt: new Date() } : {}),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiError.conflict(
          ApiErrorCode.IdempotencyConflict,
          'This RFQ reference or Sub Rosa round is already registered',
        );
      }
      throw error;
    }

    await this.webhooks.emit(
      consumer.username,
      'PRIVATE_RFQ_CREATED',
      project(created, PRIVATE_RFQ_PUBLIC_SELECT),
    );
    if (snapshot.revealComplete) {
      await this.webhooks.emit(
        consumer.username,
        'PRIVATE_RFQ_REVEALED',
        project(created, PRIVATE_RFQ_PUBLIC_SELECT),
      );
    }
    return this.view(created, snapshot);
  }

  async findAll(consumer: GatewayConsumer, query: QueryPrivateRfqsDto) {
    const where = { consumer: { apisixUsername: consumer.username } };
    const [data, total] = await Promise.all([
      this.prisma.privateRfq.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: PRIVATE_RFQ_PUBLIC_SELECT,
      }),
      this.prisma.privateRfq.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PrivateRfqView> {
    const rfq = await this.getOwned(consumer, id);
    const snapshot = await this.readExisting(rfq);
    this.assertRound(rfq.reference, snapshot);
    return this.view(rfq, snapshot);
  }

  async sync(consumer: GatewayConsumer, id: string): Promise<PrivateRfqView> {
    const { rfq, snapshot } = await this.synchronize(consumer, id);
    return this.view(rfq, snapshot);
  }

  async select(
    consumer: GatewayConsumer,
    id: string,
    provider: string,
  ): Promise<PrivateRfqView> {
    const synchronized = await this.synchronize(consumer, id);
    const { rfq, snapshot } = synchronized;
    if (!snapshot.revealComplete || rfq.status === 'VOIDED') {
      throw ApiError.conflict(
        ApiErrorCode.PrivateRfqStateInvalid,
        'A quote cannot be selected before the Sub Rosa reveal is complete',
      );
    }
    const quote = snapshot.quotes.find((entry) => entry.provider === provider);
    if (!quote?.revealed || !quote.valid || quote.amount === null) {
      throw ApiError.badRequest(
        ApiErrorCode.PrivateRfqStateInvalid,
        'The selected provider has no valid revealed quote',
      );
    }
    if (rfq.selectedProvider === provider) return this.view(rfq, snapshot);

    const claim = await this.prisma.privateRfq.updateMany({
      where: { id, status: 'REVEALED', selectedProvider: null },
      data: {
        status: 'SELECTED',
        selectedProvider: provider,
        selectedAmount: quote.amount,
        selectedAt: new Date(),
      },
    });
    const selected = await this.prisma.privateRfq.findUniqueOrThrow({
      where: { id },
    });
    if (claim.count === 0) {
      if (selected.selectedProvider === provider) {
        return this.view(selected, snapshot);
      }
      throw ApiError.conflict(
        ApiErrorCode.PrivateRfqStateInvalid,
        `RFQ ${id} already selected another provider`,
      );
    }
    await this.webhooks.emit(
      consumer.username,
      'PRIVATE_RFQ_SELECTED',
      project(selected, PRIVATE_RFQ_PUBLIC_SELECT),
    );
    return this.view(selected, snapshot);
  }

  async createPaymentIntent(
    consumer: GatewayConsumer,
    id: string,
    dto: CreateRfqPaymentIntentDto,
  ) {
    const { rfq, snapshot } = await this.synchronize(consumer, id);
    if (!rfq.selectedProvider || !rfq.selectedAmount) {
      throw ApiError.conflict(
        ApiErrorCode.PrivateRfqStateInvalid,
        'Select a valid revealed quote before creating a payment intent',
      );
    }
    if (rfq.paymentIntentId) {
      return {
        privateRfq: this.view(rfq, snapshot),
        paymentIntent: await this.paymentIntents.findOne(
          consumer,
          rfq.paymentIntentId,
        ),
      };
    }

    const quote = snapshot.quotes.find(
      (entry) => entry.provider === rfq.selectedProvider,
    );
    if (
      !quote?.revealed ||
      !quote.valid ||
      quote.amount !== rfq.selectedAmount
    ) {
      throw ApiError.conflict(
        ApiErrorCode.PrivateRfqStateInvalid,
        'The selected quote no longer matches verified Sub Rosa state',
      );
    }
    const amount = this.decimalAmount(rfq.selectedAmount, rfq.assetDecimals);
    const assetCode = rfq.assetCode === 'native' ? undefined : rfq.assetCode;
    const common = {
      destination: rfq.selectedProvider,
      amount,
      assetCode,
      assetIssuer: rfq.assetIssuer ?? undefined,
      memo: privateRfqMemo(rfq.id),
      msg: dto.msg ?? `Private RFQ ${rfq.reference}`,
      callback: dto.callback,
    };
    const paymentIntent =
      dto.kind === 'TX'
        ? await this.paymentIntents.createTx(consumer, {
            ...common,
            source: dto.source!,
          })
        : await this.paymentIntents.createPay(consumer, common);

    const linked = await this.prisma.privateRfq.update({
      where: { id },
      data: { paymentIntentId: paymentIntent.id },
    });
    return {
      privateRfq: this.view(linked, snapshot),
      paymentIntent,
    };
  }

  private async synchronize(consumer: GatewayConsumer, id: string) {
    const current = await this.getOwned(consumer, id);
    const snapshot = await this.readExisting(current);
    this.assertRound(current.reference, snapshot);
    const nextStatus =
      current.status === 'SELECTED' ? 'SELECTED' : this.statusOf(snapshot);
    const firstReveal =
      snapshot.revealComplete &&
      current.status !== 'REVEALED' &&
      current.status !== 'SELECTED';
    const transition = await this.prisma.privateRfq.updateMany({
      where: { id, status: current.status },
      data: {
        status: nextStatus,
        roundStatus: snapshot.roundStatus,
        commitDeadline: this.dateFromSeconds(snapshot.commitDeadline),
        revealDeadline: this.dateFromSeconds(snapshot.revealDeadline),
        ...(firstReveal ? { revealedAt: new Date() } : {}),
      },
    });
    const rfq = await this.prisma.privateRfq.findUniqueOrThrow({
      where: { id },
    });
    if (firstReveal && transition.count === 1) {
      await this.webhooks.emit(
        consumer.username,
        'PRIVATE_RFQ_REVEALED',
        project(rfq, PRIVATE_RFQ_PUBLIC_SELECT),
      );
    }
    return { rfq, snapshot };
  }

  private async getOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PrivateRfq> {
    const rfq = await this.prisma.privateRfq.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!rfq) throw ApiError.notFound(`Private RFQ ${id} not found`);
    return rfq;
  }

  private assertConsumerNetwork(
    consumer: GatewayConsumer,
    network: 'public' | 'testnet',
  ): void {
    const expected = resolveNetwork(this.config, consumer);
    if (network !== expected) {
      throw ApiError.badRequest(
        ApiErrorCode.SubRosaNetworkMismatch,
        `API key is scoped to ${expected}, not ${network}`,
      );
    }
  }

  private assertRound(reference: string, snapshot: SubRosaRoundSnapshot): void {
    if (snapshot.mode !== 'ReceiptOnly') {
      this.invalidRound('round mode must be ReceiptOnly');
    }
    if (snapshot.clearingRule !== 'LowestBid') {
      this.invalidRound('round clearing rule must be LowestBid');
    }
    if (!snapshot.sealedProposalSchema) {
      this.invalidRound('round schema is not sub-rosa:sealed-proposal:v1');
    }
    const expectedItemRef = privateRfqItemRef(reference).toString('hex');
    if (snapshot.itemRefHex !== expectedItemRef) {
      this.invalidRound(
        'round item_ref does not match the Cosmos Pay RFQ reference',
      );
    }
  }

  private assertAsset(assetCode: string, assetIssuer?: string): void {
    if (assetCode === 'native' && assetIssuer) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'assetIssuer must be omitted for native XLM',
      );
    }
    if (assetCode !== 'native' && !assetIssuer) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'assetIssuer is required for a non-native asset',
      );
    }
  }

  private statusOf(snapshot: SubRosaRoundSnapshot): PrivateRfqStatus {
    if (snapshot.roundStatus === 'Voided') return 'VOIDED';
    if (snapshot.revealComplete) return 'REVEALED';
    if (snapshot.roundStatus === 'Open') return 'OPEN';
    return 'REVEALING';
  }

  private view(
    rfq: PrivateRfq,
    snapshot?: SubRosaRoundSnapshot,
  ): PrivateRfqView {
    return {
      ...project(rfq, PRIVATE_RFQ_PUBLIC_SELECT),
      ...(snapshot ? { quotes: snapshot.quotes } : {}),
    };
  }

  private dateFromSeconds(seconds: bigint): Date {
    const millis = seconds * 1000n;
    if (millis < 0n || millis > BigInt(8_640_000_000_000_000)) {
      this.invalidRound('round deadline is outside the supported date range');
    }
    return new Date(Number(millis));
  }

  private decimalAmount(baseUnits: string, decimals: number): string {
    const amount = BigInt(baseUnits);
    if (amount <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'Selected quote amount must be positive',
      );
    }
    if (decimals === 0) return amount.toString();
    const digits = amount.toString().padStart(decimals + 1, '0');
    const whole = digits.slice(0, -decimals);
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  private async readRegistration(
    dto: CreatePrivateRfqDto,
  ): Promise<SubRosaRoundSnapshot> {
    try {
      return await this.rounds.read(dto.network, dto.contractId, dto.roundId);
    } catch (error) {
      if (error instanceof SubRosaRoundReadError) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidSubRosaRound,
          error.message,
        );
      }
      throw error;
    }
  }

  private async readExisting(rfq: PrivateRfq): Promise<SubRosaRoundSnapshot> {
    try {
      return await this.rounds.read(
        rfq.network as 'public' | 'testnet',
        rfq.contractId,
        rfq.roundId,
      );
    } catch (error) {
      if (error instanceof SubRosaRoundReadError) {
        throw ApiError.badGateway(ApiErrorCode.ProviderError, error.message);
      }
      throw error;
    }
  }

  private invalidRound(message: string): never {
    throw ApiError.badRequest(ApiErrorCode.InvalidSubRosaRound, message);
  }
}
