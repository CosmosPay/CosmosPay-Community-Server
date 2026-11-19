import { Injectable, Logger } from '@nestjs/common';
import type { WebhookEventType } from '@generated/prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { P2P_NETWORKS, isP2pNetworkId } from '@/p2p/p2p-networks';
import { toOrderWebhookData, type P2pOrderRow } from '@/p2p/p2p-views';
import type { StellarNetwork } from '@/config/configuration';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

/** The order events, by the status that caused them. */
export type P2pOrderEvent = Extract<
  WebhookEventType,
  | 'P2P_ORDER_CREATED'
  | 'P2P_ORDER_ACCEPTED'
  | 'P2P_ORDER_PAID'
  | 'P2P_ORDER_COMPLETED'
  | 'P2P_ORDER_CANCELLED'
  | 'P2P_ORDER_EXPIRED'
  | 'P2P_ORDER_DISPUTED'
  | 'P2P_ORDER_RESOLVED'
  | 'P2P_ORDER_FAILED'
>;

/** The event an order's new status emits. */
export const P2P_STATUS_EVENTS: Record<string, P2pOrderEvent | undefined> = {
  awaiting_payment: 'P2P_ORDER_ACCEPTED',
  paid: 'P2P_ORDER_PAID',
  completed: 'P2P_ORDER_COMPLETED',
  cancelled: 'P2P_ORDER_CANCELLED',
  expired: 'P2P_ORDER_EXPIRED',
  disputed: 'P2P_ORDER_DISPUTED',
  resolved: 'P2P_ORDER_RESOLVED',
  failed: 'P2P_ORDER_FAILED',
};

/**
 * The P2P market's webhooks. An order's event goes to the consumer that
 * created it (`role: "client"`) and, when another consumer's account is its
 * merchant, to that consumer too (`role: "merchant"`). The body is the order's
 * public fields: no payment method, payer identity or beneficiary account for
 * either role (`toOrderWebhookData`); the routes read those.
 *
 * Terminal events go through the durable emitter, whose dedup key is the
 * event, the resource id and the epoch: the merchant's copy uses epoch 1 so the
 * two deliveries are two claims, not one swallowing the other.
 */
@Injectable()
export class P2pWebhooks {
  private readonly logger = new Logger(P2pWebhooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: WebhookTerminalEmitter,
  ) {}

  private async usernameOf(consumerId: string): Promise<string | null> {
    const row = await this.prisma.consumer.findUnique({
      where: { id: consumerId },
      select: { apisixUsername: true },
    });
    return row?.apisixUsername ?? null;
  }

  /** Emits an order event to its client and, if another consumer, its merchant. Never throws. */
  async order(type: P2pOrderEvent, row: P2pOrderRow): Promise<void> {
    try {
      const chainId = isP2pNetworkId(row.network)
        ? (P2P_NETWORKS[row.network].tiers[row.tier as StellarNetwork]
            ?.chainId ?? 0)
        : 0;
      const client = await this.usernameOf(row.consumerId);
      if (client) {
        await this.emitter.emit(client, type, {
          ...toOrderWebhookData(row, chainId, 'client'),
          settlementEpoch: 0,
        });
      }
      if (row.merchantConsumerId !== row.consumerId) {
        const merchant = await this.usernameOf(row.merchantConsumerId);
        if (merchant) {
          await this.emitter.emit(merchant, type, {
            ...toOrderWebhookData(row, chainId, 'merchant'),
            settlementEpoch: 1,
          });
        }
      }
    } catch (err) {
      this.logger.error(
        `P2P webhook ${type} for order ${row.id} not emitted: ${String(err)}`,
      );
    }
  }

  /** A charge was paid by one of its orders (to the charge's consumer only). */
  async chargeSucceeded(
    consumerId: string,
    data: { id: string; orderId: string; paidCount: number } & Record<
      string,
      unknown
    >,
  ): Promise<void> {
    try {
      const username = await this.usernameOf(consumerId);
      if (username) {
        // One event per paying order: a multi-use charge succeeds once per
        // payer, so its paid count is the dedup epoch.
        await this.emitter.emit(username, 'P2P_CHARGE_SUCCEEDED', {
          ...data,
          settlementEpoch: data.paidCount,
        });
      }
    } catch (err) {
      this.logger.error(
        `P2P webhook P2P_CHARGE_SUCCEEDED for charge ${data.id} not emitted: ${String(err)}`,
      );
    }
  }

  /** Every order of a payout batch ended. */
  async payoutBatchCompleted(
    consumerId: string,
    data: { id: string } & Record<string, unknown>,
  ): Promise<void> {
    try {
      const username = await this.usernameOf(consumerId);
      if (username) {
        await this.emitter.emit(username, 'P2P_PAYOUT_BATCH_COMPLETED', data);
      }
    } catch (err) {
      this.logger.error(
        `P2P webhook P2P_PAYOUT_BATCH_COMPLETED for batch ${data.id} not emitted: ${String(err)}`,
      );
    }
  }
}
