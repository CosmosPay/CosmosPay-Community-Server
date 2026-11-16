import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { AppConfig } from '@/config/configuration';
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
  PAYMENT_RECEIPT_LIMIT_WINDOW_MS,
  PAYMENT_RECEIPT_LOCK_CLASS,
  PAYMENT_RECEIPT_MAX_PER_MERCHANT,
  PAYMENT_RECEIPT_MAX_PER_RECIPIENT,
  RECEIPT_LANGS,
} from '@/payment-intents/payment-intents.constants';
import { paymentExplorerTxUrl } from '@/payment-intents/payment-explorers';
import { receiptRecipient } from '@/payment-intents/payment-payer-session';
import { isPaymentNetwork } from '@/payment-intents/payment-networks';
import { PrismaService } from '@/prisma/prisma.service';
import { WEBHOOK_EVENT, WebhookEventPayload } from '@/webhooks/webhook-events';

/**
 * The receipt a payer gets when a payment made through the hosted checkout
 * succeeds, at the email their checkout session gave before paying: the
 * deposit's session when a deposit settled it, else `receiptRecipient` among
 * the link's sessions (the one whose registered transaction or account matches
 * the settlement; else the only session, without a customer link; nobody
 * otherwise, marked `receiptSkippedAt`).
 *
 * It listens to the settlement itself (`PAYMENT_INTENT_SUCCEEDED` on the
 * internal bus, whatever settled it: the chain observer, `validate`, a
 * deposit), so no settlement path has to remember to send it. A receipt is
 * claimed before it is sent (`receiptClaimedAt`, a lease of
 * `PAYMENT_RECEIPT_CLAIM_MS`) so one replica sends it, and marked
 * `receiptSentAt` after; one that could not go out (no mail sender, the sender
 * down) is released and retried by `PaymentReceiptSweeperService`.
 *
 * The address was typed by the payer and never verified, so the receipt says
 * only what this service generated (amount, asset, network, date, ids, the
 * payment's page and the transaction's explorer page), never a merchant's
 * text, and no address gets more than `PAYMENT_RECEIPT_MAX_PER_RECIPIENT`
 * receipts a day, nor any merchant send more than
 * `PAYMENT_RECEIPT_MAX_PER_MERCHANT` (`reserve`): one over either waits for
 * the window, it is not dropped.
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
    private readonly config: ConfigService<AppConfig, true>,
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
        network: true,
        amount: true,
        asset: true,
        txHash: true,
        updatedAt: true,
        paidFrom: true,
        source: true,
        paidOnChainAt: true,
      },
    });
    if (!intent) return false;
    const paidFrom = readPaidFrom(intent.paidFrom);
    const deposit = paidFrom
      ? await this.prisma.paymentDeposit.findUnique({
          where: { id: paidFrom.depositId },
          select: {
            amountOutPaid: true,
            amountOut: true,
            payerSession: { select: { email: true, lang: true } },
          },
        })
      : null;
    // The deposit's session proves itself: only it was given that deposit
    // address. Otherwise a session's registered proof must match the
    // settlement (`receiptRecipient`).
    const recipient = paidFrom
      ? deposit?.payerSession
        ? { session: deposit.payerSession, proven: true }
        : null
      : receiptRecipient(
          await this.prisma.paymentPayerSession.findMany({
            where: { intentId: id },
            select: {
              email: true,
              lang: true,
              walletAddress: true,
              walletTxHash: true,
              provenAt: true,
            },
          }),
          {
            chain: intent.chain,
            txHash: intent.txHash,
            source: intent.source,
            paidAt: intent.paidOnChainAt ?? intent.updatedAt,
          },
        );
    if (!recipient) {
      // Paid outside the checkout (a wallet link scanned elsewhere, the API),
      // or by a payer who cannot be told apart from the others who gave an
      // email: no receipt and no customer link. Decided once; the merchant
      // sees the emails given (`GET /v1/payment-intents/{id}/payer-emails`).
      await this.prisma.$executeRaw`
        UPDATE "payment_intent" SET "receiptSkippedAt" = ${new Date()}
         WHERE "id" = ${id} AND "receiptSentAt" IS NULL`;
      return false;
    }
    const email = recipient.session.email.toLowerCase();

    // A customer only for a payer who proved the payment was theirs; an
    // unproven single session gets the receipt (on-chain facts) and no more.
    if (recipient.proven) {
      void this.customers
        .linkPayerEmail(intent.consumerId, email)
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not link the payer of intent ${id} to a customer: ${String(err)}`,
          ),
        );
    }

    if (!this.mailer.configured) {
      await this.release(id);
      this.logger.warn(
        `Receipt for payment intent ${id} waits: no mail sender is configured`,
      );
      return false;
    }

    if (!(await this.reserve(id, intent.consumerId, email))) {
      // Over a daily limit: the claim is kept, so the sweeper asks again once
      // the lease lapses, and sends it when the window allows.
      this.logger.warn(
        `Receipt for payment intent ${id} held: its recipient or merchant is over the daily receipt limit`,
      );
      return false;
    }

    const lang = asReceiptLang(recipient.session.lang);
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
      explorerUrl: isPaymentNetwork(intent.chain)
        ? paymentExplorerTxUrl(
            intent.chain,
            intent.network === 'testnet' ? 'testnet' : 'public',
            intent.txHash,
          )
        : null,
      paymentUrl: `${this.config.get('paymentIntents', { infer: true }).checkoutUrl}/${encodeURIComponent(intent.id)}`,
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

  /**
   * Books this receipt against the day's limits, or answers false when the
   * recipient or the merchant has used theirs. Under a transaction-scoped
   * advisory lock on the recipient, so two replicas cannot both take an
   * address's last receipt (the merchant's count may pass its limit by the
   * receipts other replicas book for other addresses at that moment). A retry
   * of a receipt already booked to this address counts once.
   */
  private reserve(
    id: string,
    consumerId: string,
    email: string,
  ): Promise<boolean> {
    const since = new Date(Date.now() - PAYMENT_RECEIPT_LIMIT_WINDOW_MS);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAYMENT_RECEIPT_LOCK_CLASS}::int, hashtext(${email}))`;
      const booked = await tx.paymentIntent.findUnique({
        where: { id },
        select: { receiptTo: true },
      });
      if (booked?.receiptTo === email) return true;
      const toRecipient = await tx.paymentIntent.count({
        where: {
          receiptTo: email,
          receiptToAt: { gt: since },
          id: { not: id },
        },
      });
      if (toRecipient >= PAYMENT_RECEIPT_MAX_PER_RECIPIENT) return false;
      const fromMerchant = await tx.paymentIntent.count({
        where: { consumerId, receiptToAt: { gt: since }, id: { not: id } },
      });
      if (fromMerchant >= PAYMENT_RECEIPT_MAX_PER_MERCHANT) return false;
      // Raw SQL so `updatedAt` keeps meaning a change of the intent itself (the
      // sweeper's window reads it).
      await tx.$executeRaw`
        UPDATE "payment_intent"
           SET "receiptTo" = ${email}, "receiptToAt" = ${new Date()}
         WHERE "id" = ${id}`;
      return true;
    });
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
