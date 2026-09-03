import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WebhookEventType } from '@generated/prisma/client';
import { isUniqueViolation } from '@/common/prisma-errors';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookDispatcherService } from '@/webhooks/webhook-dispatcher.service';
import {
  WEBHOOK_EVENT,
  WebhookEventPayload,
  isTerminalWebhookEvent,
  terminalEventDedupKey,
} from '@/webhooks/webhook-events';

/**
 * Single emission point for domain webhook events.
 *
 * Non-terminal events (CREATED / SUBMITTED / …) go straight to the bus.
 * Terminal settlement events insert `webhook_emitted_event` under the unique
 * `dedupKey` **and** write their `webhook_delivery` rows in one transaction.
 * Winning that insert is what authorizes the bus emit; a unique-constraint
 * violation means another path already notified.
 */
@Injectable()
export class WebhookTerminalEmitter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    // `@Optional` for the same reason as the settlement observer's lock: unit
    // tests in other modules construct this emitter by hand with a fake Prisma.
    // Wired (always, in the running app) the claim and the delivery rows commit
    // together; unwired it claims only and the bus listener persists, which is
    // what happens for every non-terminal event anyway.
    @Optional() private readonly dispatcher?: WebhookDispatcherService,
  ) {}

  /**
   * @returns `true` when this call owned the notification (or the event is
   * not terminal). `false` when a concurrent/prior claim already emitted.
   */
  async emit(
    consumerUsername: string,
    type: WebhookEventType,
    data: unknown,
  ): Promise<boolean> {
    const payload = new WebhookEventPayload(consumerUsername, type, data);

    if (!isTerminalWebhookEvent(type)) {
      this.events.emit(WEBHOOK_EVENT, payload);
      return true;
    }

    const resourceId = resourceIdOf(data);
    if (!resourceId) {
      throw new Error(
        `Terminal webhook event ${type} requires data.id to build the dedup key`,
      );
    }

    const deliveryIds = await this.claimAndRecord(
      payload,
      resourceId,
      settlementEpochOf(data),
    );
    if (!deliveryIds) return false;

    this.events.emit(
      WEBHOOK_EVENT,
      new WebhookEventPayload(consumerUsername, type, data, deliveryIds),
    );
    return true;
  }

  /**
   * Claims the dedup row and writes the delivery rows it authorizes, in one
   * transaction. Returns the new delivery ids, or `null` when another path
   * already owns the notification.
   *
   * The order used to be: commit the claim, then hand the work to an in-memory
   * EventEmitter, and only then (inside the listener) write the delivery row. A
   * crash, an OOM or a rolling deploy anywhere in that window burned the claim
   * with nothing on disk to show for it, and because the claim is permanent no
   * later path could re-emit — a settled payment notified nobody, ever. Writing
   * both together means the claim cannot outlive the work it authorizes: either
   * there are delivery rows (which the sweeper will finish if this process dies
   * mid-send), or the claim was never taken and the next caller wins it.
   *
   * Relies on the database unique index rather than a pre-check, which would
   * race under concurrent observer + submit.
   */
  private async claimAndRecord(
    payload: WebhookEventPayload,
    resourceId: string,
    settlementEpoch: number,
  ): Promise<string[] | null> {
    const dedupKey = terminalEventDedupKey(
      payload.type,
      resourceId,
      settlementEpoch,
    );
    const dispatcher = this.dispatcher;

    try {
      if (!dispatcher) {
        // Unwired (hand-built unit tests only — see the constructor): claim
        // alone, and let the bus listener persist as it does for non-terminal
        // events. Never the path a running application takes.
        await this.prisma.webhookEmittedEvent.create({
          data: { dedupKey, eventType: payload.type },
        });
        return [];
      }

      return await this.prisma.$transaction(async (tx) => {
        await tx.webhookEmittedEvent.create({
          data: { dedupKey, eventType: payload.type },
        });
        const pending = await dispatcher.persistDeliveries(payload, tx);
        return pending.map(({ delivery }) => delivery.id);
      });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }
}

function resourceIdOf(data: unknown): string | undefined {
  if (
    data !== null &&
    typeof data === 'object' &&
    'id' in data &&
    typeof data.id === 'string'
  ) {
    return (data as { id: string }).id;
  }
  return undefined;
}

function settlementEpochOf(data: unknown): number {
  if (
    data !== null &&
    typeof data === 'object' &&
    'settlementEpoch' in data &&
    typeof data.settlementEpoch === 'number'
  ) {
    return (data as { settlementEpoch: number }).settlementEpoch;
  }
  return 0;
}
