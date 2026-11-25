import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { BankIncomeService } from '@/native-plugins/koywe/bank-income.service';
import { BankTransferConversion } from '@/native-plugins/koywe/bank-transfer-conversion.service';
import { BankTransferOrders } from '@/native-plugins/koywe/bank-transfer-orders.service';
import {
  readEnvelope,
  readKybEvent,
  verifyingNetwork,
  type KoyweEnvelope,
} from '@/native-plugins/koywe/koywe-webhook';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import {
  KOYWE_BANK_INCOME_EVENT,
  KOYWE_KYB_EVENTS,
  KOYWE_ORDER_EVENT_PREFIX,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';
import { TransferAccountsService } from '@/native-plugins/koywe/transfer-accounts.service';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';
import { PrismaService } from '@/prisma/prisma.service';

/** The signed parts of a delivery, as the controller read them. */
export interface KoyweWebhookDelivery {
  rawBody: Buffer | undefined;
  signature: string | undefined;
}

/** What the provider calls each environment, per network. */
const ENVIRONMENTS: Record<StellarNetwork, string> = {
  public: 'production',
  testnet: 'sandbox',
};

type Handler = (
  network: StellarNetwork,
  envelope: KoyweEnvelope,
) => Promise<void>;

/**
 * The provider's webhook (`POST /v1/onramp/transfer/webhooks`): one endpoint
 * per environment, for every merchant of Cosmos Pay's organization.
 *
 * A delivery is accepted only when `Koywe-Signature` is the HMAC-SHA256 of the
 * raw body under one network's webhook secret (compared in constant time); that
 * network is the only one whose records it may change. The envelope id is
 * written first (`bank_transfer_webhook_event`, unique), so a redelivery is
 * recognised and applied once; only a failure to write it is answered 5xx (the
 * provider then delivers again). The answer goes back as soon as the delivery
 * is stored; what needs the provider (the conversion, reading an order back,
 * opening a virtual account) runs after it, and the sweep finishes whatever
 * dies on the way.
 */
@Injectable()
export class BankTransferWebhooks implements OnModuleDestroy {
  private readonly logger = new Logger(BankTransferWebhooks.name);
  private readonly pending = new Set<Promise<void>>();

  /** Each event type this plugin acts on, tried in order. Every other one is acknowledged and ignored. */
  private readonly handlers: readonly {
    matches: (type: string) => boolean;
    handle: Handler;
  }[] = [
    {
      matches: (type) => type === KOYWE_BANK_INCOME_EVENT,
      handle: (network, envelope) => this.onDeposit(network, envelope),
    },
    {
      matches: (type) => type.startsWith(KOYWE_ORDER_EVENT_PREFIX),
      handle: (network, envelope) =>
        this.afterRecording(network, envelope, () =>
          this.orders.onEvent(network, envelope),
        ),
    },
    {
      matches: (type) => type in KOYWE_KYB_EVENTS,
      handle: (network, envelope) => this.onKyb(network, envelope),
    },
  ];

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: KoyweClient,
    private readonly income: BankIncomeService,
    private readonly conversion: BankTransferConversion,
    private readonly orders: BankTransferOrders,
    private readonly accounts: TransferAccountsService,
    private readonly rails: PaymentRequestRails,
  ) {}

  async receive(delivery: KoyweWebhookDelivery): Promise<{ received: true }> {
    const raw = delivery.rawBody;
    if (!raw || raw.length === 0) throw this.refuse('the body is empty');
    const secrets = this.config.get('koywe', { infer: true }).environments;
    const network = verifyingNetwork(raw, delivery.signature, {
      public: secrets.public.webhookSecret,
      testnet: secrets.testnet.webhookSecret,
    });
    if (!network) {
      throw this.refuse(
        delivery.signature
          ? 'Koywe-Signature verifies against no configured secret'
          : 'Koywe-Signature is missing',
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.warn(
        `A signed ${KOYWE_PROVIDER} webhook (${network}) is not JSON; ignored`,
      );
      return { received: true };
    }
    const envelope = readEnvelope(body);
    if (!envelope) {
      this.logger.warn(
        `A signed ${KOYWE_PROVIDER} webhook (${network}) has no envelope id or type; ignored`,
      );
      return { received: true };
    }
    if (
      envelope.organizationId &&
      envelope.organizationId !== this.client.organizationId(network)
    ) {
      this.logger.warn(
        `${KOYWE_PROVIDER} ${envelope.type} ${envelope.id} (${network}) is for organization ${envelope.organizationId}, not this deployment's; ignored`,
      );
      return { received: true };
    }
    if (
      envelope.environment &&
      envelope.environment !== ENVIRONMENTS[network]
    ) {
      this.logger.warn(
        `${KOYWE_PROVIDER} ${envelope.type} ${envelope.id} verified as ${network} but says environment ${envelope.environment}; applied as ${network}`,
      );
    }
    const handler = this.handlers.find((entry) => entry.matches(envelope.type));
    if (!handler) return { received: true };
    await handler.handle(network, envelope);
    return { received: true };
  }

  /** Resolves when the work started after the deliveries so far has finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.settled();
  }

  /**
   * A deposit: recorded and matched in one transaction, the request moved to
   * `processing` at once (so the payer's page shows it), then converted.
   */
  private async onDeposit(
    network: StellarNetwork,
    envelope: KoyweEnvelope,
  ): Promise<void> {
    const recorded = await this.income.record(network, envelope);
    if (recorded.duplicate) return;
    const transfer = recorded.transfer;
    if (!transfer) {
      await this.processed(envelope.id);
      return;
    }
    try {
      await this.rails
        .ledger()
        .markProcessing(transfer.paymentRequestId, new Date());
    } catch (error) {
      // The conversion moves it again before ordering.
      this.logger.error(
        `Payment request ${transfer.paymentRequestId} could not be marked processing: ${describe(error)}`,
      );
    }
    this.later(envelope.id, () => this.conversion.convert(transfer.id));
  }

  /** A KYB outcome for one of the sellers' merchants. */
  private onKyb(network: StellarNetwork, envelope: KoyweEnvelope) {
    const kyb = readKybEvent(envelope.data);
    const merchantId = envelope.merchantId ?? kyb.merchantId;
    const status = KOYWE_KYB_EVENTS[envelope.type];
    return this.afterRecording(network, envelope, async () => {
      if (!merchantId) {
        this.logger.warn(
          `${KOYWE_PROVIDER} ${envelope.type} ${envelope.id} (${network}) names no merchant; ignored`,
        );
        return;
      }
      await this.accounts.applyKyb(network, merchantId, status, kyb);
    });
  }

  /** Records the delivery, then (once, a redelivery changes nothing) does `work` after answering. */
  private async afterRecording(
    network: StellarNetwork,
    envelope: KoyweEnvelope,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await this.prisma.bankTransferWebhookEvent.create({
        data: { id: envelope.id, network, type: envelope.type },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          `${KOYWE_PROVIDER} ${envelope.type} ${envelope.id} (${network}) was already received: ignored`,
        );
        return;
      }
      throw error;
    }
    this.later(envelope.id, work);
  }

  /** Runs `work` after the answer, marking the delivery processed when it succeeds. */
  private later(eventId: string, work: () => Promise<void>): void {
    const run = Promise.resolve()
      .then(work)
      .then(() => this.processed(eventId))
      .catch((error: unknown) => {
        this.logger.error(
          `${KOYWE_PROVIDER} delivery ${eventId} could not be applied (the sweep retries what it started): ${describe(error)}`,
        );
      })
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  private async processed(eventId: string): Promise<void> {
    await this.prisma.bankTransferWebhookEvent.updateMany({
      where: { id: eventId, processedAt: null },
      data: { processedAt: new Date() },
    });
  }

  private refuse(why: string): ApiError {
    this.logger.warn(`Refused a ${KOYWE_PROVIDER} webhook: ${why}`);
    return ApiError.unauthorized(
      ApiErrorCode.WebhookSignatureInvalid,
      'Invalid webhook signature',
    );
  }
}

/** An error, for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
