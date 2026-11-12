import { Injectable, Logger } from '@nestjs/common';
import type { StellarNetwork } from '@/config/configuration';
import { shortReason } from '@/native-plugins/koywe/bank-transfer';
import {
  holdReason,
  mergeOrders,
  readOrder,
  type KoyweEnvelope,
  type KoyweOrderState,
} from '@/native-plugins/koywe/koywe-webhook';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import {
  KOYWE_ONRAMP,
  KOYWE_ORDER_EVENT_OUTCOMES,
  KOYWE_ORDER_OUTCOMES,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';
import { PrismaService } from '@/prisma/prisma.service';

/** What applying an order outcome loads of a transfer. */
export const ORDER_TRANSFER_SELECT = {
  id: true,
  network: true,
  paymentRequestId: true,
  providerMerchantId: true,
  providerOrderId: true,
  providerStatus: true,
  status: true,
  deliveredAmount: true,
  txHash: true,
} as const;

/** A transfer as {@link ORDER_TRANSFER_SELECT} loads it. */
export interface OrderTransfer {
  id: string;
  network: string;
  paymentRequestId: string;
  providerMerchantId: string;
  providerOrderId: string | null;
  providerStatus: string | null;
  status: string;
  deliveredAmount: string | null;
  txHash: string | null;
}

/**
 * What the provider's ONRAMP order of a transfer became: from its webhook
 * (`order.*`) or read back by the sweep. Completed: the transfer is
 * `completed` with the token delivered (and its transaction, when any field of
 * the order carries one) and the payment request turns `paid` by `transfer`,
 * unless another payment paid it first (logged: the money reached the seller
 * twice). Failed, expired, cancelled or refunded: the transfer is `failed`, the
 * request stays `processing` (the pesos are in the merchant's balance: ops
 * refunds or converts them by hand). Anything else updates its status. Every
 * write is conditional on `converting`, so a late or repeated event changes
 * nothing.
 */
@Injectable()
export class BankTransferOrders {
  private readonly logger = new Logger(BankTransferOrders.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KoyweClient,
    private readonly rails: PaymentRequestRails,
  ) {}

  /** An order event verified as `network`'s. A completion reads the order back for what the event leaves out. */
  async onEvent(
    network: StellarNetwork,
    envelope: KoyweEnvelope,
  ): Promise<void> {
    const event = readOrder(envelope.data);
    if (event.type !== KOYWE_ONRAMP) return;
    const transfer = await this.find(network, event);
    if (!transfer) {
      this.logger.warn(
        `${KOYWE_PROVIDER} ${envelope.type} for order ${event.orderId ?? '(no id)'} (${network}) names no bank transfer: external id ${event.externalId ?? '(none)'}`,
      );
      return;
    }
    if (
      envelope.merchantId &&
      envelope.merchantId !== transfer.providerMerchantId
    ) {
      this.logger.warn(
        `${KOYWE_PROVIDER} ${envelope.type} for bank transfer ${transfer.id} came from merchant ${envelope.merchantId}, not ${transfer.providerMerchantId}: ignored`,
      );
      return;
    }
    const outcome = KOYWE_ORDER_EVENT_OUTCOMES[envelope.type] ?? null;
    let order = event;
    const orderId = event.orderId ?? transfer.providerOrderId;
    if (outcome === 'completed' && orderId) {
      try {
        order = mergeOrders(
          event,
          readOrder(
            await this.client.order(
              network,
              transfer.providerMerchantId,
              orderId,
            ),
          ),
        );
      } catch (error) {
        this.logger.warn(
          `${KOYWE_PROVIDER} order ${orderId} (${network}) could not be read back: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.apply(transfer, order, outcome);
  }

  /** Reads a transfer's order back (the sweep: the webhook may have been lost) and applies it. */
  async refresh(transfer: OrderTransfer): Promise<void> {
    if (!transfer.providerOrderId) return;
    const order = readOrder(
      await this.client.order(
        transfer.network as StellarNetwork,
        transfer.providerMerchantId,
        transfer.providerOrderId,
      ),
    );
    await this.apply(transfer, order, null);
  }

  /** Applies `order` to `transfer`; `eventOutcome` is what the event type said, else the order's status decides. */
  async apply(
    transfer: OrderTransfer,
    order: KoyweOrderState,
    eventOutcome: 'completed' | 'failed' | null,
  ): Promise<void> {
    const outcome =
      eventOutcome ??
      (order.status ? KOYWE_ORDER_OUTCOMES[order.status] : undefined) ??
      null;
    const now = new Date();
    const known = {
      providerStatus: order.status ?? transfer.providerStatus,
      checkedAt: now,
      ...(order.orderId && !transfer.providerOrderId
        ? { providerOrderId: order.orderId }
        : {}),
    };
    const converting = { id: transfer.id, status: 'converting' };

    if (outcome === 'completed') {
      if (!order.amountOut) {
        await this.prisma.bankTransfer.updateMany({
          where: converting,
          data: known,
        });
        this.logger.warn(
          `Bank transfer ${transfer.id}: its order completed without an amount delivered; the sweep reads it back`,
        );
        return;
      }
      const done = await this.prisma.bankTransfer.updateMany({
        where: converting,
        data: {
          ...known,
          status: 'completed',
          deliveredAmount: order.amountOut,
          txHash: order.txHash,
          completedAt: now,
          reason: null,
        },
      });
      if (done.count > 0) {
        this.logger.log(
          `Bank transfer ${transfer.id} completed: ${order.amountOut} delivered${order.txHash ? ` in ${order.txHash}` : ''}`,
        );
        await this.settle(transfer.paymentRequestId, {
          amount: order.amountOut,
          txHash: order.txHash,
          at: now,
          healing: false,
        });
      } else if (transfer.status === 'completed') {
        await this.settle(transfer.paymentRequestId, {
          amount: transfer.deliveredAmount,
          txHash: transfer.txHash,
          at: now,
          healing: true,
        });
      }
      return;
    }

    if (outcome === 'failed') {
      const failed = await this.prisma.bankTransfer.updateMany({
        where: converting,
        data: {
          ...known,
          status: 'failed',
          failedAt: now,
          reason: shortReason(`order ${order.status ?? 'failed'}`),
        },
      });
      if (failed.count > 0) {
        this.logger.error(
          `Bank transfer ${transfer.id}: its order ${order.orderId ?? transfer.providerOrderId ?? ''} ended ${order.status ?? 'failed'}; ` +
            `the pesos are in merchant ${transfer.providerMerchantId}'s balance and payment request ${transfer.paymentRequestId} stays processing: refund or convert by hand`,
        );
      }
      return;
    }

    const hold = holdReason(order);
    await this.prisma.bankTransfer.updateMany({
      where: converting,
      data: { ...known, ...(hold ? { reason: hold } : {}) },
    });
    if (hold) {
      this.logger.error(
        `Bank transfer ${transfer.id}: its order waits for a person (${hold}); approve it, or allow ONRAMP orders for the API user`,
      );
    }
  }

  /** The transfer an order names: by its external id (the transfer id), else by the provider's order id. */
  private async find(
    network: StellarNetwork,
    order: KoyweOrderState,
  ): Promise<OrderTransfer | null> {
    if (order.externalId) {
      const byExternal = await this.prisma.bankTransfer.findFirst({
        where: { id: order.externalId, network },
        select: ORDER_TRANSFER_SELECT,
      });
      if (byExternal) return byExternal;
    }
    return order.orderId
      ? this.prisma.bankTransfer.findFirst({
          where: { providerOrderId: order.orderId, network },
          select: ORDER_TRANSFER_SELECT,
        })
      : null;
  }

  /**
   * Pays the request by `transfer`. `healing`: the transfer had completed
   * before (a repeated event), so the request is paid only when an earlier
   * attempt died before paying it.
   */
  private async settle(
    requestId: string,
    delivered: {
      amount: string | null;
      txHash: string | null;
      at: Date;
      healing: boolean;
    },
  ): Promise<void> {
    const ledger = this.rails.ledger();
    if (delivered.healing) {
      const request = await ledger.find(requestId);
      if (!request || request.paidAt) return;
    }
    await ledger.markPaid(requestId, {
      method: 'transfer',
      amount: delivered.amount,
      txHash: delivered.txHash,
      at: delivered.at,
    });
  }
}
