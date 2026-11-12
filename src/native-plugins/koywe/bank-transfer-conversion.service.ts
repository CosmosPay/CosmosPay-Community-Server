import { Injectable, Logger } from '@nestjs/common';
import type { StellarNetwork } from '@/config/configuration';
import { BankTransferRail } from '@/native-plugins/koywe/bank-transfer-rail.service';
import {
  retryDelayMs,
  shortReason,
} from '@/native-plugins/koywe/bank-transfer';
import {
  BankTransferOrders,
  ORDER_TRANSFER_SELECT,
} from '@/native-plugins/koywe/bank-transfer-orders.service';
import {
  BankTransferOnHold,
  KoyweCryptoAccounts,
} from '@/native-plugins/koywe/koywe-crypto-accounts.service';
import { holdReason, readOrder } from '@/native-plugins/koywe/koywe-webhook';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import {
  BANK_TRANSFER_CLAIM_MS,
  BANK_TRANSFER_CURRENCY,
  KOYWE_ONRAMP,
  KOYWE_ORDER_OUTCOMES,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';
import { PrismaService } from '@/prisma/prisma.service';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Converts a matched deposit to the payment request's token and sends it to
 * the seller's address, under the merchant the deposit landed in: the seller's
 * CRYPTO account for that address (registered once), a quote for the whole
 * deposit, and an ONRAMP order whose `externalId` is the transfer's id (the
 * provider keeps one order per external id, so an attempt repeated after a
 * crash finds the first one instead of paying twice).
 *
 * An attempt holds the transfer for a few minutes (`nextAttemptAt`, a
 * conditional write), so the webhook's attempt and the sweep's never run at
 * once. A failure, or an approval policy that holds the order or the account,
 * keeps the transfer `converting` with the provider's status and a short
 * reason, logs an error and leaves it to the sweep, which retries a minute
 * later, doubling to an hour.
 */
@Injectable()
export class BankTransferConversion {
  private readonly logger = new Logger(BankTransferConversion.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KoyweClient,
    private readonly rails: PaymentRequestRails,
    private readonly rail: BankTransferRail,
    private readonly accounts: KoyweCryptoAccounts,
    private readonly orders: BankTransferOrders,
  ) {}

  async convert(transferId: string): Promise<void> {
    const transfer = await this.prisma.bankTransfer.findUnique({
      where: { id: transferId },
      select: {
        ...ORDER_TRANSFER_SELECT,
        depositAmount: true,
        attempts: true,
      },
    });
    if (
      !transfer ||
      transfer.status !== 'converting' ||
      transfer.providerOrderId ||
      !transfer.depositAmount
    ) {
      return;
    }
    const now = new Date();
    const claimed = await this.prisma.bankTransfer.updateMany({
      where: {
        id: transfer.id,
        status: 'converting',
        providerOrderId: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: { nextAttemptAt: new Date(now.getTime() + BANK_TRANSFER_CLAIM_MS) },
    });
    if (claimed.count === 0) return;

    const network = transfer.network as StellarNetwork;
    const merchantId = transfer.providerMerchantId;
    try {
      const ledger = this.rails.ledger();
      const request = await ledger.find(transfer.paymentRequestId);
      if (!request) throw new Error('its payment request is gone');
      await ledger.markProcessing(request.id, now);
      const target = this.rail.target(
        network,
        request.chainId,
        request.tokenAddress,
        { symbol: request.token, decimals: request.tokenDecimals },
      );
      if (!target) {
        throw new Error(
          `no conversion to token ${request.tokenAddress} on chain ${request.chainId}`,
        );
      }

      // An attempt that died after ordering left the order behind.
      let raw =
        transfer.attempts > 0
          ? await this.client.orderByExternalId(
              network,
              merchantId,
              transfer.id,
            )
          : null;
      let quoteId: string | null = null;
      if (!raw) {
        const accountId = await this.accounts.accountFor(
          network,
          merchantId,
          target,
          request.address,
        );
        const quote = await this.client.quote(network, merchantId, {
          orderType: KOYWE_ONRAMP,
          executable: true,
          originCurrencySymbol: BANK_TRANSFER_CURRENCY,
          destinationCurrencySymbol: target.token,
          amountIn: Number(transfer.depositAmount),
          network: target.network,
        });
        quoteId = text(quote.id);
        if (!quoteId) throw new Error('the quote came back without an id');
        raw = await this.client.createOrder(network, merchantId, {
          type: KOYWE_ONRAMP,
          quoteId,
          destinationAccountId: accountId,
          externalId: transfer.id,
          description: `Cosmos Pay charge ${request.id}`,
        });
      }
      const order = readOrder(raw);
      if (!order.orderId) throw new Error('the order came back without an id');
      const hold = holdReason(order);
      await this.prisma.bankTransfer.updateMany({
        where: { id: transfer.id, status: 'converting' },
        data: {
          providerOrderId: order.orderId,
          ...(quoteId ? { providerQuoteId: quoteId } : {}),
          providerStatus: order.status,
          reason: hold,
          attempts: transfer.attempts + 1,
          nextAttemptAt: null,
          checkedAt: now,
        },
      });
      if (hold) {
        this.logger.error(
          `Bank transfer ${transfer.id} (${network}): order ${order.orderId} waits for a person (${hold}); approve it, or allow ONRAMP orders for the API user`,
        );
      } else {
        this.logger.log(
          `Bank transfer ${transfer.id} (${network}): ${transfer.depositAmount} ARS ordered as ${target.token} on ${target.network} (order ${order.orderId}, ${order.status ?? 'no status'})`,
        );
      }
      if (order.status && KOYWE_ORDER_OUTCOMES[order.status]) {
        await this.orders.apply(
          { ...transfer, providerOrderId: order.orderId },
          order,
          null,
        );
      }
    } catch (error) {
      const onHold = error instanceof BankTransferOnHold;
      const reason = shortReason(
        onHold
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error),
      );
      const delay = retryDelayMs(transfer.attempts);
      await this.prisma.bankTransfer.updateMany({
        where: { id: transfer.id, status: 'converting', providerOrderId: null },
        data: {
          attempts: transfer.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + delay),
          reason,
          ...(onHold ? { providerStatus: error.providerStatus } : {}),
        },
      });
      this.logger.error(
        `Bank transfer ${transfer.id} (${network}) could not be converted by ${KOYWE_PROVIDER} (attempt ${transfer.attempts + 1}, next in ${Math.round(delay / 1000)} s): ${reason}`,
      );
    }
  }
}
