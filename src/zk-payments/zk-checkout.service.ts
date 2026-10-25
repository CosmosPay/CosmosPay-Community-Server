import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
import type { StellarNetwork, ZkNetworkConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { ConfidentialSdk } from '@/zk-payments/confidential-sdk';
import type { ConfirmZkPaymentDto } from '@/zk-payments/dto/confirm-zk-payment.dto';
import type {
  PublicZkPaymentEntity,
  ZkPaymentsConfigEntity,
} from '@/zk-payments/entities/zk-payment.entity';
import { toStroops } from '@/swaps/swap-math';
import { effectiveZkStatus } from '@/zk-payments/zk-payment-status';
import { verifyZkSettlement } from '@/zk-payments/zk-payment-verification';
import {
  isStellarNetwork,
  ZkNetworksService,
  zkTokenOf,
} from '@/zk-payments/zk-networks.service';
import {
  toZkPaymentView,
  ZK_PAYMENT_PUBLIC_SELECT,
} from '@/zk-payments/zk-payments.service';
import { ZK_PAYMENT_AUDITOR_ID } from '@/zk-payments/zk-payments.constants';

/**
 * The columns the checkout loads: what a payer is shown, plus what confirming
 * needs (`tokenContract`, `createdAt`, the stored hashes). Never `consumerId`
 * or `idempotencyKey`; {@link toPublicZkPayment} picks the response field by
 * field on top of that.
 */
const ZK_CHECKOUT_SELECT = {
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
  paymentTxHash: true,
  feeTxHash: true,
  description: true,
  expiresAt: true,
  createdAt: true,
} as const satisfies Prisma.ZkPaymentSelect;

type ZkCheckoutRow = Prisma.ZkPaymentGetPayload<{
  select: typeof ZK_CHECKOUT_SELECT;
}>;

/**
 * The anonymous half of private payments, behind the keyless `/v1/zk-checkout`
 * prefix: the network setup a wallet proves against, a payment as its payer
 * sees it, and the confirm that settles it after reading both transfers back
 * from the chain.
 *
 * Kept apart from `ZkPaymentsService`, whose every read is scoped to the
 * calling consumer: these routes are `@Public()`, have no consumer, and answer
 * for any tenant's payment. The id is the capability.
 */
@Injectable()
export class ZkCheckoutService {
  private readonly logger = new Logger(ZkCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly networks: ZkNetworksService,
    private readonly sdk: ConfidentialSdk,
    private readonly webhooks: WebhookTerminalEmitter,
  ) {}

  /** A network's setup: the same builder as the authenticated config. */
  config(network: StellarNetwork): ZkPaymentsConfigEntity {
    return this.networks.configFor(network);
  }

  /** The payment `id` as its payer sees it. */
  async findPublic(id: string): Promise<PublicZkPaymentEntity> {
    const row = await this.load(id);
    return this.toPublic(row, this.networkOf(row), new Date());
  }

  /**
   * Settles the payment `id` with the two transfers the payer made, after
   * reading both back from the chain and decrypting them with the auditor key
   * (`verifyZkSettlement` has the rules and their order).
   *
   * Idempotent: confirming a settled payment with the hashes it settled with
   * answers it again. A transaction that settled another private payment, of any
   * consumer, is refused before the chain is asked anything.
   */
  async confirm(
    id: string,
    dto: ConfirmZkPaymentDto,
  ): Promise<PublicZkPaymentEntity> {
    const paymentTxHash = dto.paymentTxHash.toLowerCase();
    const feeTxHash = dto.feeTxHash.toLowerCase();
    if (paymentTxHash === feeTxHash) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'paymentTxHash and feeTxHash must be two different transactions.',
      );
    }

    const row = await this.load(id);
    const zk = this.networkOf(row);

    if (row.status === 'SUCCEEDED') {
      return await this.replaySettled(row, zk, paymentTxHash, feeTxHash);
    }

    // Before any chain read: a transaction already spent on another payment
    // gets no further, so this route never decrypts it again for anyone.
    await this.assertUnused(row.id, paymentTxHash, feeTxHash);

    const [payment, fee] = await Promise.all([
      this.sdk.readTransaction(zk, zk.auditorSecret, paymentTxHash),
      this.sdk.readTransaction(zk, zk.auditorSecret, feeTxHash),
    ]);
    const settlement = verifyZkSettlement(
      {
        token: row.tokenContract,
        network: row.network,
        recipient: row.recipient,
        feeAccount: row.feeAccount,
        netStroops: toStroops(row.netAmount),
        feeStroops: toStroops(row.feeAmount),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      },
      payment,
      fee,
    );

    let claimed: number;
    try {
      ({ count: claimed } = await this.prisma.zkPayment.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'SUCCEEDED',
          payer: settlement.payer,
          paymentTxHash,
          feeTxHash,
          settledAt: settlement.settledAt,
        },
      }));
    } catch (err) {
      if (isUniqueViolation(err)) throw alreadySettled();
      throw err;
    }
    if (claimed === 0) {
      // Someone else settled it between the read and the write.
      return this.replaySettled(
        await this.load(id),
        zk,
        paymentTxHash,
        feeTxHash,
      );
    }

    this.logger.log(
      `Settled private payment ${row.id} on ${row.network}: payer=${settlement.payer} ` +
        `payment=${paymentTxHash} fee=${feeTxHash}`,
    );
    await this.notifySettled(row.id);
    return this.toPublic(
      { ...row, status: 'SUCCEEDED', paymentTxHash, feeTxHash },
      zk,
      new Date(),
    );
  }

  private async load(id: string): Promise<ZkCheckoutRow> {
    const row = await this.prisma.zkPayment.findUnique({
      where: { id },
      select: ZK_CHECKOUT_SELECT,
    });
    if (!row) throw ApiError.notFound(`Private payment ${id} not found`);
    return row;
  }

  /**
   * The network setup the payment was created on. The token must still be the
   * one it was priced on: a payment on a token this deployment no longer
   * serves can be neither paid nor confirmed here.
   */
  private networkOf(row: ZkCheckoutRow): ZkNetworkConfig {
    if (!isStellarNetwork(row.network)) {
      throw new Error(
        `Private payment ${row.id} is on unknown network ${row.network}`,
      );
    }
    const zk = this.networks.require(row.network);
    if (zk.token !== row.tokenContract) {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        `This private payment was made on token ${row.tokenContract}, which this ` +
          `deployment no longer serves on ${row.network}.`,
      );
    }
    return zk;
  }

  /**
   * A settled payment: the same answer for the same hashes, else a 400.
   *
   * The same-hash replay notifies again. The emitter deduplicates terminal
   * events (`ZK_PAYMENT_SUCCEEDED:<id>:0`), so this sends nothing twice; what it
   * does is heal the one gap the settle path has: a process that died between
   * the compare-and-swap and the emit settled the payment and notified nobody,
   * and the payer's retry lands here.
   */
  private async replaySettled(
    row: ZkCheckoutRow,
    zk: ZkNetworkConfig,
    paymentTxHash: string,
    feeTxHash: string,
  ): Promise<PublicZkPaymentEntity> {
    if (
      row.status === 'SUCCEEDED' &&
      row.paymentTxHash === paymentTxHash &&
      row.feeTxHash === feeTxHash
    ) {
      await this.notifySettled(row.id);
      return this.toPublic(row, zk, new Date());
    }
    throw ApiError.badRequest(
      ApiErrorCode.InvalidStateTransition,
      'This private payment is already settled, by other transactions.',
    );
  }

  /**
   * `ZK_PAYMENT_SUCCEEDED` to the owning consumer, with the owner's view of the
   * row (never `consumerId`). Durable and deduplicated by the emitter: it
   * writes the delivery rows in the same transaction as its claim.
   */
  private async notifySettled(id: string): Promise<void> {
    const settled = await this.prisma.zkPayment.findUniqueOrThrow({
      where: { id },
      select: {
        ...ZK_PAYMENT_PUBLIC_SELECT,
        consumer: { select: { apisixUsername: true } },
      },
    });
    const { consumer, ...ownerRow } = settled;
    await this.webhooks.emit(
      consumer.apisixUsername,
      'ZK_PAYMENT_SUCCEEDED',
      toZkPaymentView(project(ownerRow, ZK_PAYMENT_PUBLIC_SELECT), new Date()),
    );
  }

  /** Neither hash may have settled another private payment, in either role. */
  private async assertUnused(
    id: string,
    paymentTxHash: string,
    feeTxHash: string,
  ): Promise<void> {
    const hashes = [paymentTxHash, feeTxHash];
    const used = await this.prisma.zkPayment.findFirst({
      where: {
        id: { not: id },
        OR: [{ paymentTxHash: { in: hashes } }, { feeTxHash: { in: hashes } }],
      },
      select: { id: true },
    });
    if (used) throw alreadySettled();
  }

  /** Field by field, so nothing the row carries besides these can leave. */
  private toPublic(
    row: ZkCheckoutRow,
    zk: ZkNetworkConfig,
    now: Date,
  ): PublicZkPaymentEntity {
    return {
      id: row.id,
      status: effectiveZkStatus(row, now),
      amount: row.amount,
      netAmount: row.netAmount,
      feeAmount: row.feeAmount,
      feeBps: row.feeBps,
      recipient: row.recipient,
      feeAccount: row.feeAccount,
      description: row.description,
      expiresAt: row.expiresAt,
      network: row.network,
      rpcUrl: zk.rpcUrl,
      networkPassphrase: zk.networkPassphrase,
      token: zkTokenOf(zk),
      auditorId: ZK_PAYMENT_AUDITOR_ID,
    };
  }
}

function alreadySettled(): ApiError {
  return ApiError.conflict(
    ApiErrorCode.TransactionAlreadySettled,
    'One of these transactions already settled another private payment. One ' +
      'transaction settles at most one payment.',
  );
}
