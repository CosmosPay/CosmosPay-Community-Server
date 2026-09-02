import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  Prisma,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventType,
} from '@generated/prisma/client';
import { WEBHOOK_EVENT, WebhookEventPayload } from '@/webhooks/webhook-events';
import { buildSignatureHeader } from '@/webhooks/webhook-signature';
import { WebhookDestinationGuard } from '@/webhooks/webhook-destination.guard';
import {
  jitteredBackoffMs,
  WebhookHttpClient,
  WebhookHttpResponse,
} from '@/webhooks/webhook-http';
import { WebhookUrlValidationError } from '@/webhooks/webhook-url.validator';

/** A durable delivery row paired with the endpoint it is owed to. */
export interface PendingDelivery {
  endpoint: WebhookEndpoint;
  delivery: WebhookDelivery;
}

/**
 * Whatever can write delivery rows: the Prisma client, or an interactive
 * transaction when the rows must commit together with something else (the
 * terminal emitter's dedup claim).
 */
export type WebhookDeliveryWriter = Pick<
  PrismaService,
  'webhookEndpoint' | 'webhookDelivery'
>;

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly destinations: WebhookDestinationGuard,
    // Injected in the application, so a test can replace outbound HTTP through
    // DI instead of monkey-patching whatever global the transport happens to
    // use. Defaulted so hand-built unit tests need not pass it.
    private readonly http: WebhookHttpClient = new WebhookHttpClient(),
  ) {}

  /**
   * Fans out a domain event to every enabled endpoint of the owning consumer
   * that is subscribed to the event type (empty subscription list = all).
   * Runs out-of-band (async) so it never blocks the request that emitted it.
   *
   * Terminal events arrive with `deliveryIds`: their rows were committed by
   * {@link WebhookTerminalEmitter} in the same transaction as the dedup claim,
   * so the work is already on disk before the in-memory bus is touched and this
   * handler must send exactly those rows rather than mint new ones. Events
   * published straight onto the bus are persisted here instead.
   */
  @OnEvent(WEBHOOK_EVENT, { async: true, promisify: true })
  async handleEvent(payload: WebhookEventPayload): Promise<void> {
    // This is fired by `events.emit(...)`, a synchronous fire-and-forget call —
    // nobody holds the returned promise. Anything escaping here is an unhandled
    // rejection, and under Node's default policy that terminates the process.
    // Most throw sites are covered, but not all: `markDestinationBlocked` and
    // `finalize` both issue Prisma writes from inside a catch, so an endpoint
    // deleted concurrently (P2025) or a saturated pool is enough to take the pod
    // down. A failed notification must cost the delivery, never the process —
    // the rows stay PENDING/FAILED and the sweeper retries them.
    try {
      const pending = payload.deliveryIds?.length
        ? await this.loadDeliveries(payload.deliveryIds)
        : await this.persistDeliveries(payload);

      await Promise.all(
        pending.map(({ endpoint, delivery }) =>
          this.attempt(endpoint, delivery),
        ),
      );
    } catch (err) {
      this.logger.error(
        `Webhook dispatch failed for ${payload.type} (${payload.consumerUsername})`,
        err as Error,
      );
    }
  }

  /**
   * Writes one PENDING delivery row per subscribed endpoint and returns them
   * ready to send. Nothing else in the pipeline may create delivery rows: this
   * is the point at which an event becomes durable work.
   *
   * `writer` is the caller's transaction when the rows have to commit alongside
   * a dedup claim; it defaults to the client for plain bus events.
   */
  async persistDeliveries(
    payload: WebhookEventPayload,
    writer: WebhookDeliveryWriter = this.prisma,
  ): Promise<PendingDelivery[]> {
    const endpoints = await writer.webhookEndpoint.findMany({
      where: {
        enabled: true,
        destinationBlocked: false,
        consumer: { apisixUsername: payload.consumerUsername },
      },
    });

    const targets = endpoints.filter(
      (e) => e.eventTypes.length === 0 || e.eventTypes.includes(payload.type),
    );
    if (targets.length === 0) {
      return [];
    }

    const eventId = `evt_${randomUUID()}`;
    this.logger.log(
      `Dispatching ${payload.type} (${eventId}) to ${targets.length} endpoint(s) for ${payload.consumerUsername}`,
    );

    // One `evt_` id for the whole fan-out: receivers dedupe on it.
    const body = this.buildBody(eventId, payload.type, payload.data);
    const pending: PendingDelivery[] = [];
    for (const endpoint of targets) {
      const delivery = await writer.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventType: payload.type,
          eventId,
          payload: body as Prisma.InputJsonValue,
          status: 'PENDING',
        },
      });
      pending.push({ endpoint, delivery });
    }
    return pending;
  }

  /** Loads rows persisted earlier — by the emitter's claim transaction. */
  private async loadDeliveries(
    ids: readonly string[],
  ): Promise<PendingDelivery[]> {
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { id: { in: [...ids] } },
      include: { endpoint: true },
    });
    return rows.map(({ endpoint, ...delivery }) => ({ endpoint, delivery }));
  }

  /**
   * Re-sends an existing delivery (manual redelivery / retry / sweep recovery).
   * Returns the updated record. Throws if the endpoint is gone.
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
    const { maxAttempts, backoffMs } = this.config.get('webhooks', {
      infer: true,
    });

    const body = JSON.stringify(delivery.payload);
    let attempts = delivery.attempts;
    let lastError: string | null = null;
    let responseStatus: number | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      attempts += 1;

      try {
        const res = await this.send(endpoint, body, {
          'x-cosmos-event': delivery.eventType,
          'x-cosmos-event-id': delivery.eventId,
          'x-cosmos-delivery': delivery.id,
        });
        responseStatus = res.status;

        if (res.ok) {
          return this.finalize(
            delivery.id,
            'SUCCEEDED',
            attempts,
            res.status,
            null,
          );
        }
        lastError = `Non-2xx response: ${res.status}`;
      } catch (err) {
        responseStatus = null;
        lastError =
          err instanceof Error ? err.message : 'Unknown delivery error';

        if (err instanceof WebhookUrlValidationError) {
          await this.markDestinationBlocked(endpoint.id, lastError);
          // Do not retry SSRF / destination failures — DNS will not become safe
          // by waiting, and we must not open a connection.
          break;
        }
      }

      // Jittered backoff before the next attempt (skip after the last one).
      if (i < maxAttempts - 1) {
        await sleep(jitteredBackoffMs(backoffMs, i));
      }
    }

    this.logger.warn(
      `Delivery ${delivery.id} to ${endpoint.url} failed after ${attempts} attempt(s): ${lastError}`,
    );
    return this.finalize(
      delivery.id,
      'FAILED',
      attempts,
      responseStatus,
      lastError,
    );
  }

  /**
   * One-off signed test POST to an endpoint. Not persisted as a delivery — it
   * just lets an integrator confirm reachability and signature verification.
   */
  async pingEndpoint(endpoint: WebhookEndpoint): Promise<{
    ok: boolean;
    responseStatus: number | null;
    error: string | null;
  }> {
    const body = JSON.stringify({
      id: `evt_ping_${randomUUID()}`,
      type: 'ping',
      createdAt: new Date().toISOString(),
      data: { message: 'Cosmos Pay webhook ping' },
    });

    try {
      const res = await this.send(endpoint, body, { 'x-cosmos-event': 'ping' });
      return { ok: res.ok, responseStatus: res.status, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (err instanceof WebhookUrlValidationError) {
        await this.markDestinationBlocked(endpoint.id, message);
      }
      return { ok: false, responseStatus: null, error: message };
    }
  }

  /**
   * The single point at which a webhook POST leaves the process — deliveries
   * and pings alike. Ping used to keep its own transcription of this block, so
   * the destination check, the signature, the headers and the timeouts had to
   * be kept in step by hand in two places; DNS pinning would have been a third
   * thing to remember twice.
   *
   * The destination is validated *and pinned* here: `postWebhook` connects to
   * the address this check returned instead of re-resolving `endpoint.url`.
   * Throws {@link WebhookUrlValidationError} when the destination is not
   * allowed — both callers block the endpoint on it.
   */
  private async send(
    endpoint: WebhookEndpoint,
    body: string,
    eventHeaders: Record<string, string>,
  ): Promise<WebhookHttpResponse> {
    const {
      connectTimeoutMs,
      readTimeoutMs,
      maxResponseBytes,
      signatureHeader,
    } = this.config.get('webhooks', { infer: true });

    const destination = await this.destinations.assertSafe(endpoint.url);

    return this.http.send({
      url: endpoint.url,
      destination,
      limits: { connectTimeoutMs, readTimeoutMs, maxResponseBytes },
      headers: {
        'content-type': 'application/json',
        'user-agent': 'CosmosPay-Webhooks/1.0',
        [signatureHeader]: buildSignatureHeader(
          endpoint.secret,
          body,
          Math.floor(Date.now() / 1000),
        ),
        ...eventHeaders,
      },
      body,
    });
  }

  private async markDestinationBlocked(
    endpointId: string,
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `Marking webhook endpoint ${endpointId} as destinationBlocked: ${reason}`,
    );
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        destinationBlocked: true,
        enabled: false,
      },
    });
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
