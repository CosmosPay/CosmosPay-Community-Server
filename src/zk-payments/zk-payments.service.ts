import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, ZkPayment } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { resolveIdempotencyKey } from '@/stellar/stellar-operation-policy';
import { ConfidentialSdk } from '@/zk-payments/confidential-sdk';
import type { CreateZkPaymentDto } from '@/zk-payments/dto/create-zk-payment.dto';
import type { QueryZkPaymentsDto } from '@/zk-payments/dto/query-zk-payments.dto';
import type {
  ZkPaymentEntity,
  ZkPaymentsConfigEntity,
} from '@/zk-payments/entities/zk-payment.entity';
import { splitZkPayment } from '@/zk-payments/zk-payment-fee';
import {
  effectiveZkStatus,
  zkStatusFilter,
} from '@/zk-payments/zk-payment-status';
import { ZkNetworksService } from '@/zk-payments/zk-networks.service';
import {
  ZK_PAYMENT_AUDITOR_ID,
  ZK_PAYMENT_DEFAULT_EXPIRES_IN_MINUTES,
  ZK_PAYMENT_FEE_BPS,
  ZK_PAYMENT_GENERATED_KEY_PREFIX,
} from '@/zk-payments/zk-payments.constants';

/**
 * The columns a ZK payment leaves this service with, for its owner: every
 * field `ZkPaymentEntity` documents. An allowlist, so `consumerId` never
 * leaves, including on a create replay under the shared public key.
 */
export const ZK_PAYMENT_PUBLIC_SELECT = {
  id: true,
  status: true,
  network: true,
  tokenContract: true,
  amount: true,
  netAmount: true,
  feeAmount: true,
  feeBps: true,
  recipient: true,
  feeAccount: true,
  payer: true,
  paymentTxHash: true,
  feeTxHash: true,
  description: true,
  idempotencyKey: true,
  expiresAt: true,
  settledAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ZkPaymentSelect;

type ZkPaymentRow = Prisma.ZkPaymentGetPayload<{
  select: typeof ZK_PAYMENT_PUBLIC_SELECT;
}>;

/** A row as its owner reads it: the status as it reads now. */
export function toZkPaymentView(row: ZkPaymentRow, now: Date): ZkPaymentEntity {
  return { ...row, status: effectiveZkStatus(row, now) };
}

/** What a create is compared on when its idempotency key is already taken. */
interface ZkPaymentTerms {
  network: string;
  amount: string;
  recipient: string;
  description: string | null;
}

/**
 * ZK payments as their owner (the merchant's API key) sees them: the network's
 * setup, the idempotent create, and the reads. Settlement is the anonymous
 * checkout's, in `ZkCheckoutService`.
 */
@Injectable()
export class ZkPaymentsService {
  private readonly logger = new Logger(ZkPaymentsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly networks: ZkNetworksService,
    private readonly sdk: ConfidentialSdk,
  ) {}

  /** The caller's network, as the dashboard sets up a wallet for it. */
  getConfig(consumer: GatewayConsumer): ZkPaymentsConfigEntity {
    return this.networks.configFor(resolveNetwork(this.config, consumer));
  }

  /**
   * Creates a ZK payment on the caller's network. The recipient must already
   * hold a confidential account on the token under auditor 0: a transfer to
   * anyone else would be refused on-chain, after the payer had spent a proof.
   *
   * Idempotent per consumer on the key (header first, then body, else one is
   * minted). A replay returns the stored payment only when the request is the
   * same payment; under the shared public key every anonymous caller is one
   * consumer, so a matching key alone must not hand out someone else's row.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateZkPaymentDto,
    headerIdempotencyKey?: string,
  ): Promise<ZkPaymentEntity> {
    const network = resolveNetwork(this.config, consumer);
    const zk = this.networks.require(network);

    const split = splitZkPayment(dto.amount, ZK_PAYMENT_FEE_BPS);
    if (!split) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'The amount is too small: after the 0.01% commission (at least one ' +
          'stroop) the merchant would receive nothing.',
      );
    }
    if (dto.recipient === zk.feeAccount) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        "recipient cannot be Cosmos Pay's fee account.",
      );
    }

    const local = await this.consumers.resolve(consumer);
    const idempotencyKey =
      resolveIdempotencyKey(headerIdempotencyKey, dto.idempotencyKey) ??
      `${ZK_PAYMENT_GENERATED_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
    const terms: ZkPaymentTerms = {
      network,
      amount: split.amount,
      recipient: dto.recipient,
      description: dto.description ?? null,
    };

    const existing = await this.findByKey(local.id, idempotencyKey);
    if (existing) return this.replay(existing, terms);

    const account = await this.sdk.account(zk, dto.recipient);
    if (!account.registered || account.auditorId !== ZK_PAYMENT_AUDITOR_ID) {
      throw ApiError.badRequest(
        ApiErrorCode.RecipientNotRegistered,
        `The recipient ${dto.recipient} is not registered on Cosmos Pay's ` +
          'confidential token. Register it with the wallet first, under ' +
          `auditor id ${ZK_PAYMENT_AUDITOR_ID}.`,
      );
    }

    const minutes =
      dto.expiresInMinutes ?? ZK_PAYMENT_DEFAULT_EXPIRES_IN_MINUTES;
    let row: ZkPayment;
    try {
      row = await this.prisma.zkPayment.create({
        data: {
          consumerId: local.id,
          network,
          tokenContract: zk.token,
          amount: split.amount,
          netAmount: split.netAmount,
          feeAmount: split.feeAmount,
          feeBps: ZK_PAYMENT_FEE_BPS,
          recipient: dto.recipient,
          feeAccount: zk.feeAccount,
          description: dto.description ?? null,
          idempotencyKey,
          expiresAt: new Date(Date.now() + minutes * 60_000),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent create with the same key won: held to the same replay rule.
      return this.replay(await this.findByKey(local.id, idempotencyKey), terms);
    }

    this.logger.log(
      `Created ZK payment ${row.id}: ${split.amount} XLM (net ${split.netAmount}, ` +
        `fee ${split.feeAmount}) -> ${dto.recipient} ` +
        `(consumer=${consumer.username}, network=${network})`,
    );
    return toZkPaymentView(project(row, ZK_PAYMENT_PUBLIC_SELECT), new Date());
  }

  /** The consumer's payments, newest first, filtered by status as it reads now. */
  async findAll(
    consumer: GatewayConsumer,
    query: QueryZkPaymentsDto,
  ): Promise<Page<ZkPaymentEntity>> {
    const now = new Date();
    const where: Prisma.ZkPaymentWhereInput = {
      consumer: { apisixUsername: consumer.username },
      ...(query.status ? zkStatusFilter(query.status, now) : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.zkPayment.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: ZK_PAYMENT_PUBLIC_SELECT,
      }),
      this.prisma.zkPayment.count({ where }),
    ]);
    return page(
      rows.map((row) => toZkPaymentView(row, now)),
      total,
      query,
    );
  }

  /** One of the consumer's payments. Someone else's is the same 404 as none. */
  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<ZkPaymentEntity> {
    const row = await this.prisma.zkPayment.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
      select: ZK_PAYMENT_PUBLIC_SELECT,
    });
    if (!row) throw ApiError.notFound(`ZK payment ${id} not found`);
    return toZkPaymentView(row, new Date());
  }

  private findByKey(consumerId: string, idempotencyKey: string) {
    return this.prisma.zkPayment.findUnique({
      where: { consumerId_idempotencyKey: { consumerId, idempotencyKey } },
      select: ZK_PAYMENT_PUBLIC_SELECT,
    });
  }

  /**
   * The stored payment when the request describes the same one, else 409.
   * `expiresInMinutes` is not compared: a retry a minute later asks for the
   * same lifetime and would compute another instant.
   */
  private replay(
    stored: ZkPaymentRow | null,
    terms: ZkPaymentTerms,
  ): ZkPaymentEntity {
    if (!stored) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'A concurrent request for this idempotency key changed it while this ' +
          'one was being created. Retry the request.',
      );
    }
    const same =
      stored.network === terms.network &&
      stored.amount === terms.amount &&
      stored.recipient === terms.recipient &&
      stored.description === terms.description;
    if (!same) {
      // Names nothing about the stored payment: under the shared public key it
      // may be another caller's.
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A ZK payment with this idempotency key already exists for a ' +
          'different request. Retry with the original request unchanged, or ' +
          'use a new key.',
      );
    }
    return toZkPaymentView(stored, new Date());
  }
}
