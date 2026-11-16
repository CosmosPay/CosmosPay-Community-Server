import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CustomersService } from '@/customers/customers.service';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import { MailerService } from '@/mailer/mailer.service';
import {
  type ReceiptEmailLang,
  renderPaymentReceiptEmail,
} from '@/mailer/payment-receipt-email';
import { readPaidFrom } from '@/payment-intents/payment-deposit-rules';
import {
  PAYMENT_RECEIPT_CLAIM_MS,
  RECEIPT_LANGS,
} from '@/payment-intents/payment-intents.constants';
import { isPaymentNetwork } from '@/payment-intents/payment-networks';
import { PrismaService } from '@/prisma/prisma.service';
import { WEBHOOK_EVENT, WebhookEventPayload } from '@/webhooks/webhook-events';

/**
 * The receipt a payer gets when a payment made through the hosted checkout
 * succeeds, at the email they typed before paying (the deposit's, when one
 * settled it; else the link's latest).
 *
 * It listens to the settlement itself (`PAYMENT_INTENT_SUCCEEDED` on the
 * internal bus, whatever settled it: the chain observer, `validate`, a
 * deposit), so no settlement path has to remember to send it. A receipt is
 * claimed before it is sent (`receiptClaimedAt`, a lease of
 * `PAYMENT_RECEIPT_CLAIM_MS`) so one replica sends it, and marked
 * `receiptSentAt` after; one that could not go out (no mail sender, the sender
 * down) is released and retried by `PaymentReceiptSweeperService`.
 *
 * Settling also links the payer to the merchant's customers by that email
 * (`CustomersService.linkPayerEmail`, marked as given by the payer).
 */
@Injectable()
export class PaymentReceiptsService {
  private readonly logger = new Logger(PaymentReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly customers: CustomersService,
  ) {}

  @OnEvent(WEBHOOK_EVENT, { async: true, promisify: true })
  async onEvent(payload: WebhookEventPayload): Promise<void> {
    if (payload.type !== 'PAYMENT_INTENT_SUCCEEDED') return;
    const id = (payload.data as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    // Never in the way of the settlement or its webhooks.
    await this.send(id).catch((err: unknown) =>
      this.logger.warn(
        `Receipt for payment intent ${id} not sent (retried later): ${String(err)}`,
      ),
    );
  }

  /**
   * Sends the receipt of settled intent `id` if it has an email and none went
   * out yet. Returns whether it was sent now.
   */
  async send(id: string): Promise<boolean> {
    const now = new Date();
    const leaseFrom = new Date(now.getTime() - PAYMENT_RECEIPT_CLAIM_MS);
    // Raw SQL so `updatedAt` keeps meaning a change of the intent itself.
    const claimed = await this.prisma.$executeRaw`
      UPDATE "payment_intent"
         SET "receiptClaimedAt" = ${now}
       WHERE "id" = ${id}
         AND "status" = 'SUCCEEDED'
         AND "receiptSentAt" IS NULL
         AND ("receiptClaimedAt" IS NULL OR "receiptClaimedAt" < ${leaseFrom})`;
    if (claimed === 0) return false;

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: {
        id: true,
        consumerId: true,
        chain: true,
        amount: true,
        asset: true,
        msg: true,
        txHash: true,
        updatedAt: true,
        paidFrom: true,
        payerEmail: true,
        payerLang: true,
      },
    });
    if (!intent) return false;
    const paidFrom = readPaidFrom(intent.paidFrom);
    const deposit = paidFrom
      ? await this.prisma.paymentDeposit.findUnique({
          where: { id: paidFrom.depositId },
          select: {
            payerEmail: true,
            payerLang: true,
            amountOutPaid: true,
            amountOut: true,
          },
        })
      : null;
    const email = deposit?.payerEmail ?? intent.payerEmail;
    if (!email) {
      // A payment made outside the checkout (a wallet link scanned elsewhere,
      // the API): there is nobody to send it to. The claim stays, so the
      // sweeper does not ask again.
      return false;
    }

    void this.customers
      .linkPayerEmail(intent.consumerId, email)
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not link the payer of intent ${id} to a customer: ${String(err)}`,
        ),
      );

    if (!this.mailer.configured) {
      await this.release(id);
      this.logger.warn(
        `Receipt for payment intent ${id} waits: no mail sender is configured`,
      );
      return false;
    }

    const lang = asReceiptLang(deposit?.payerLang ?? intent.payerLang);
    const network = isPaymentNetwork(intent.chain)
      ? CROSS_CHAIN_NETWORKS[intent.chain]
      : null;
    const rendered = renderPaymentReceiptEmail({
      lang,
      amount:
        intent.amount ?? deposit?.amountOutPaid ?? deposit?.amountOut ?? null,
      asset:
        intent.asset === 'native'
          ? (network?.nativeSymbol ?? intent.asset)
          : intent.asset,
      network: network?.name ?? intent.chain,
      paymentId: intent.id,
      txHash: intent.txHash,
      description: intent.msg,
      paidAt: intent.updatedAt,
      paidFrom: paidFrom
        ? {
            amount: paidFrom.amount,
            asset: paidFrom.asset,
            network:
              CROSS_CHAIN_NETWORKS[paidFrom.chain]?.name ?? paidFrom.chain,
          }
        : null,
    });
    try {
      await this.mailer.send({ to: email, ...rendered });
    } catch (err) {
      await this.release(id);
      throw err;
    }
    await this.prisma.$executeRaw`
      UPDATE "payment_intent" SET "receiptSentAt" = ${new Date()}
       WHERE "id" = ${id}`;
    this.logger.log(`Receipt sent for payment intent ${id}`);
    return true;
  }

  /** Gives the claim back, so the next sweep tries again. */
  private async release(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "payment_intent" SET "receiptClaimedAt" = NULL
       WHERE "id" = ${id} AND "receiptSentAt" IS NULL`;
  }
}

function asReceiptLang(value: string | null | undefined): ReceiptEmailLang {
  return (RECEIPT_LANGS as readonly string[]).includes(value ?? '')
    ? (value as ReceiptEmailLang)
    : 'en';
}
