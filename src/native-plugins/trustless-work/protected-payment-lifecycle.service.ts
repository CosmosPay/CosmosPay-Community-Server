import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, ProtectedPayment } from '@generated/prisma/client';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import {
  LIFECYCLE_STEPS,
  type LifecycleStepName,
  stepFrom,
} from '@/native-plugins/trustless-work/protected-payment-transitions';
import { merchantView } from '@/native-plugins/trustless-work/protected-payment-views';

/** The columns a step may set besides its own status and timestamp. */
export type StepData = Pick<
  Prisma.ProtectedPaymentUncheckedUpdateManyInput,
  | 'deliveryDeadlineAt'
  | 'evidence'
  | 'disputedBy'
  | 'disputeReason'
  | 'resolution'
>;

/**
 * The one writer of a protected payment's status, and the one emitter of its
 * webhooks. The submit routes (optimistically, when Trustless Work answers
 * SUCCESS), the sync job (from the chain) and the expiry and deadline jobs all
 * take their steps here, so each step is the same compare-and-swap whoever
 * sees it first: its status guard (`stepFrom`) and its timestamp still null.
 * Only the writer that wins emits, and the terminal events go through the
 * emitter's dedup claim as well.
 */
@Injectable()
export class ProtectedPaymentLifecycle {
  private readonly logger = new Logger(ProtectedPaymentLifecycle.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Takes `name` for the protected payment, at `at`, with `data`. Answers the
   * row as it is now when this call took the step, null when it was already
   * taken (or the status no longer allows it).
   */
  async step(
    id: string,
    name: LifecycleStepName,
    data: StepData = {},
    at: Date = new Date(),
  ): Promise<ProtectedPayment | null> {
    const step = LIFECYCLE_STEPS[name];
    const taken = await this.prisma.protectedPayment.updateMany({
      where: {
        id,
        status: { in: stepFrom(step) },
        ...(step.stamp ? { [step.stamp]: null } : {}),
      },
      data: {
        ...data,
        ...(step.to ? { status: step.to } : {}),
        ...(step.stamp ? { [step.stamp]: at } : {}),
      },
    });
    if (taken.count === 0) return null;
    const row = await this.prisma.protectedPayment.findUniqueOrThrow({
      where: { id },
    });
    this.logger.log(`Protected payment ${id}: ${name.toLowerCase()}`);
    await this.notify(row, step.event);
    return row;
  }

  /**
   * Records the deployed contract: CREATED to AWAITING_FUNDING, once, and the
   * deploy claim released. No webhook: nothing the merchant acts on happened.
   */
  async deployed(id: string, contractId: string): Promise<ProtectedPayment> {
    await this.prisma.protectedPayment.updateMany({
      where: { id, contractId: null, status: 'CREATED' },
      data: { contractId, status: 'AWAITING_FUNDING', deployClaimedAt: null },
    });
    return this.prisma.protectedPayment.findUniqueOrThrow({ where: { id } });
  }

  /** `PROTECTED_PAYMENT_CREATED`, from the create. */
  created(row: ProtectedPayment): Promise<void> {
    return this.notify(row, 'PROTECTED_PAYMENT_CREATED');
  }

  private async notify(
    row: ProtectedPayment,
    event: Parameters<WebhookTerminalEmitter['emit']>[1],
  ): Promise<void> {
    const consumer = await this.prisma.consumer.findUnique({
      where: { id: row.consumerId },
      select: { apisixUsername: true },
    });
    if (!consumer) return;
    const origin = this.config.get('paymentIntents', {
      infer: true,
    }).checkoutUrl;
    await this.webhooks.emit(
      consumer.apisixUsername,
      event,
      merchantView(row, origin),
    );
  }
}
