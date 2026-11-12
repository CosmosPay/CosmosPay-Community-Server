import { Injectable, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { StellarNetwork } from '@/config/configuration';
import { P2P_MARKETPLACE } from '@/native-plugins/eldorado/eldorado.constants';
import {
  completionProblem,
  isCompleted,
  readOrderEvent,
  type P2pOrderEvent,
} from '@/native-plugins/eldorado/p2p-order-event';
import { P2pWebhookKeys } from '@/native-plugins/eldorado/p2p-webhook-keys.service';
import {
  webhookBodyHash,
  webhookHashMatches,
} from '@/native-plugins/eldorado/p2p-webhook-signature';
import { PrismaService } from '@/prisma/prisma.service';

/** What the webhook loads of a session: enough to match an order with it. */
const SESSION_MATCH_SELECT = {
  id: true,
  side: true,
  address: true,
  chainId: true,
  tokenAddress: true,
  currency: true,
  amount: true,
  paymentRequestId: true,
} as const;

/** The signed parts of a delivery, as the controller read them. */
export interface P2pWebhookDelivery {
  rawBody: Buffer | undefined;
  hash: string | undefined;
  signature: string | undefined;
}

/**
 * The marketplace's order webhook (`POST /v1/onramp/p2p/webhooks`): verifies a
 * delivery, then records what it says on the session it names and, when it
 * reports a completed purchase of a payment request's session, marks that
 * request paid.
 *
 * Every write is conditional, so a delivery applied twice (the marketplace
 * retries, or two arrive at once) changes nothing the second time, the same
 * idea as the fiat partner's delivery claim without a table of its own: a
 * session takes a status only while it is not completed, and a request is paid
 * only while it has no `paidAt` (the first completion wins). Settling the request
 * runs on every COMPLETED delivery, even one whose session was already
 * completed, which is what heals a delivery that died between the two writes.
 */
@Injectable()
export class P2pOrderEventsService {
  private readonly logger = new Logger(P2pOrderEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: P2pWebhookKeys,
  ) {}

  /**
   * Verifies `delivery` (the body's hash, then its signature against each
   * network's keys: 401 `webhook_signature_invalid` when either fails) and
   * applies the order it reports on the network whose key signed it. A body
   * that reports no order, or names no session of that network, is logged and
   * acknowledged: the marketplace has nothing to send again.
   */
  async receive(delivery: P2pWebhookDelivery): Promise<{ received: true }> {
    const raw = delivery.rawBody;
    if (!raw || raw.length === 0 || !webhookHashMatches(raw, delivery.hash)) {
      throw this.refuse('the body does not match x-webhook-hash');
    }
    const network = await this.keys.signer(
      webhookBodyHash(raw),
      delivery.signature ?? '',
    );
    if (!network) {
      throw this.refuse('the signature verifies against no published key');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.warn(
        `A signed ${P2P_MARKETPLACE} webhook (${network}) is not JSON; ignored`,
      );
      return { received: true };
    }
    const order = readOrderEvent(body);
    if (!order) {
      this.logger.warn(
        `A signed ${P2P_MARKETPLACE} webhook (${network}) reports no order this service reads; ignored`,
      );
      return { received: true };
    }
    await this.apply(network, order);
    return { received: true };
  }

  /**
   * Records `order` on the session of `network` its `externalReferenceId`
   * names, and settles that session's payment request when the order completed
   * it. An unknown reference is logged and ignored.
   */
  async apply(network: StellarNetwork, order: P2pOrderEvent): Promise<void> {
    const session = order.reference
      ? await this.prisma.p2pRampSession.findFirst({
          where: { reference: order.reference, network },
          select: SESSION_MATCH_SELECT,
        })
      : null;
    if (!session) {
      this.logger.warn(
        `${P2P_MARKETPLACE} order ${order.orderId ?? '(no id)'} (${order.status}, ${network}) names no session: reference ${order.reference ?? '(none)'}`,
      );
      return;
    }
    const now = new Date();
    const completed = isCompleted(order);
    // Only a session not completed yet takes a status: a late event (an
    // ACCEPTED delivered after the COMPLETED) never moves it back.
    const written = await this.prisma.p2pRampSession.updateMany({
      where: { id: session.id, completedAt: null },
      data: {
        providerStatus: order.status,
        ...(order.orderId ? { providerOrderId: order.orderId } : {}),
        ...(completed
          ? {
              deliveredAmount: order.amountOut,
              txHash: order.txHash,
              completedAt: now,
            }
          : {}),
      },
    });
    this.logger.log(
      `${P2P_MARKETPLACE} order ${order.orderId ?? '(no id)'} is ${order.status} for session ${session.id}` +
        (written.count === 0 ? ' (already completed; unchanged)' : ''),
    );
    if (completed && session.paymentRequestId) {
      await this.settle(session.paymentRequestId, session, order, now);
    }
  }

  /**
   * Marks the payment request paid by this completed order, unless the order
   * does not pay it ({@link completionProblem}: logged) or a completion already
   * did. Paid whatever the request reads as: an expired or cancelled request
   * still received the money.
   */
  private async settle(
    requestId: string,
    session: { id: string } & Parameters<typeof completionProblem>[1],
    order: P2pOrderEvent,
    now: Date,
  ): Promise<void> {
    const problem = completionProblem(order, session);
    if (problem) {
      this.logger.warn(
        `${P2P_MARKETPLACE} order ${order.orderId ?? '(no id)'} completed session ${session.id} but does not pay payment request ${requestId}: ${problem}`,
      );
      return;
    }
    const paid = await this.prisma.p2pPaymentRequest.updateMany({
      where: { id: requestId, paidAt: null },
      data: {
        status: 'paid',
        paidAt: now,
        paidAmount: order.amountOut,
        paidTxHash: order.txHash,
        paidSessionId: session.id,
      },
    });
    if (paid.count > 0) {
      this.logger.log(
        `Payment request ${requestId} paid by session ${session.id} (${order.amountOut ?? '?'} delivered)`,
      );
    }
  }

  private refuse(why: string): ApiError {
    this.logger.warn(`Refused a ${P2P_MARKETPLACE} webhook: ${why}`);
    return ApiError.unauthorized(
      ApiErrorCode.WebhookSignatureInvalid,
      'Invalid webhook signature',
    );
  }
}
