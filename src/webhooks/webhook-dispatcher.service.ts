import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventType,
} from '../../generated/prisma/client';
import { WEBHOOK_EVENT, WebhookEventPayload } from './webhook-events';
import { buildSignatureHeader } from './webhook-signature';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Fans out a domain event to every enabled endpoint of the owning consumer
   * that is subscribed to the event type (empty subscription list = all).
   * Runs out-of-band (async) so it never blocks the request that emitted it.
   */
  @OnEvent(WEBHOOK_EVENT, { async: true, promisify: true })
  async handleEvent(payload: WebhookEventPayload): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        enabled: true,
        consumer: { apisixUsername: payload.consumerUsername },
      },
    });

    const targets = endpoints.filter(
      (e) => e.eventTypes.length === 0 || e.eventTypes.includes(payload.type),
    );

    if (targets.length === 0) {
      return;
    }

    const eventId = `evt_${randomUUID()}`;
    this.logger.log(
      `Dispatching ${payload.type} (${eventId}) to ${targets.length} endpoint(s) for ${payload.consumerUsername}`,
    );

    await Promise.all(
      targets.map((endpoint) =>
        this.createAndDeliver(endpoint, payload.type, eventId, payload.data),
      ),
    );
  }

  /** Creates a delivery record then attempts to send it. */
  private async createAndDeliver(
    endpoint: WebhookEndpoint,
    eventType: WebhookEventType,
    eventId: string,
    data: unknown,
  ): Promise<void> {
    const body = this.buildBody(eventId, eventType, data);

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventType,
        eventId,
        payload: body as object,
        status: 'PENDING',
      },
    });

    await this.attempt(endpoint, delivery);
  }

  /**
   * Re-sends an existing delivery (manual redelivery / retry). Returns the
   * updated record. Throws if the endpoint is gone.
   */
  async redeliver(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: delivery.endpointId },
    });
    if (!endpoint) {
      throw new Error(`Endpoint ${delivery.endpointId} no longer exists`);
    }
    return this.attempt(endpoint, delivery);
  }

  /** The retry loop: POSTs the signed payload until success or attempts run out. */
  private async attempt(
    endpoint: WebhookEndpoint,
    delivery: WebhookDelivery,
  ): Promise<WebhookDelivery> {
    const { maxAttempts, backoffMs, timeoutMs, signatureHeader } =
      this.config.get('webhooks', { infer: true });

    const body = JSON.stringify(delivery.payload);
    let attempts = delivery.attempts;
    let lastError: string | null = null;
    let responseStatus: number | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      attempts += 1;
      const timestamp = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      const timer = global.setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'CosmosPay-Webhooks/1.0',
            [signatureHeader]: buildSignatureHeader(
              endpoint.secret,
              body,
              timestamp,
            ),
            'x-cosmos-event': delivery.eventType,
            'x-cosmos-event-id': delivery.eventId,
            'x-cosmos-delivery': delivery.id,
          },
          body,
        });
        responseStatus = res.status;

        if (res.ok) {
          return this.finalize(delivery.id, 'SUCCEEDED', attempts, res.status, null);
        }
        lastError = `Non-2xx response: ${res.status}`;
      } catch (err) {
        lastError =
          err instanceof Error ? err.message : 'Unknown delivery error';
        responseStatus = null;
      } finally {
        global.clearTimeout(timer);
      }

      // Linear backoff before the next attempt (skip after the last one).
      if (i < maxAttempts - 1) {
        await sleep(backoffMs * (i + 1));
      }
    }

    this.logger.warn(
      `Delivery ${delivery.id} to ${endpoint.url} failed after ${attempts} attempt(s): ${lastError}`,
    );
    return this.finalize(delivery.id, 'FAILED', attempts, responseStatus, lastError);
  }

  /**
   * One-off signed test POST to an endpoint. Not persisted as a delivery — it
   * just lets an integrator confirm reachability and signature verification.
   */
  async pingEndpoint(
    endpoint: WebhookEndpoint,
  ): Promise<{ ok: boolean; responseStatus: number | null; error: string | null }> {
    const { timeoutMs, signatureHeader } = this.config.get('webhooks', {
      infer: true,
    });
    const body = JSON.stringify({
      id: `evt_ping_${randomUUID()}`,
      type: 'ping',
      createdAt: new Date().toISOString(),
      data: { message: 'Cosmos Pay webhook ping' },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const timer = global.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'CosmosPay-Webhooks/1.0',
          [signatureHeader]: buildSignatureHeader(endpoint.secret, body, timestamp),
          'x-cosmos-event': 'ping',
        },
        body,
      });
      return { ok: res.ok, responseStatus: res.status, error: null };
    } catch (err) {
      return {
        ok: false,
        responseStatus: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    } finally {
      global.clearTimeout(timer);
    }
  }

  private finalize(
    id: string,
    status: 'SUCCEEDED' | 'FAILED',
    attempts: number,
    responseStatus: number | null,
    error: string | null,
  ): Promise<WebhookDelivery> {
    return this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        status,
        attempts,
        responseStatus,
        error,
        lastAttemptAt: new Date(),
      },
    });
  }

  private buildBody(
    eventId: string,
    eventType: WebhookEventType,
    data: unknown,
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data,
    };
  }
}
