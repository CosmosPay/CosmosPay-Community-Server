import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApiError, ApiErrorCode } from '../common/errors/api-error';
import { isRedactedPayload } from './webhook-payload-retention';
import { PrismaService } from '../prisma/prisma.service';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import type {
  WebhookDelivery,
  WebhookEndpoint,
} from '../../generated/prisma/client';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { QueryDeliveriesDto } from './dto/query-deliveries.dto';
import { QueryEndpointsDto } from './dto/query-endpoints.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { WebhookUrlValidationError } from './webhook-url.validator';

// Endpoint without the signing secret — what list/get responses return.
export type SafeWebhookEndpoint = Omit<WebhookEndpoint, 'secret'>;

// Delivery without the sent body — see listDeliveries for why the body is not
// readable back through an endpoint gated on `webhooks:read`.
export type SafeWebhookDelivery = Omit<WebhookDelivery, 'payload'>;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly destinations: WebhookDestinationGuard,
  ) {}

  private resolveConsumer(consumer: GatewayConsumer) {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  private generateSecret(): string {
    return `whsec_${randomBytes(24).toString('hex')}`;
  }

  private strip(endpoint: WebhookEndpoint): SafeWebhookEndpoint {
    const { secret: _secret, ...safe } = endpoint;
    return safe;
  }

  // ── CRUD: endpoints ─────────────────────────────────────────────────────────
  /** Returns the full endpoint INCLUDING the secret — shown only once, here. */
  async create(
    consumer: GatewayConsumer,
    dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpoint> {
    await this.assertUrlAllowed(dto.url);
    const localConsumer = await this.resolveConsumer(consumer);

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        consumerId: localConsumer.id,
        url: dto.url,
        secret: this.generateSecret(),
        description: dto.description,
        eventTypes: dto.eventTypes ?? [],
        destinationBlocked: false,
      },
    });

    this.logger.log(
      `Registered webhook endpoint ${endpoint.id} (${endpoint.url}) for ${consumer.username}`,
    );
    return endpoint;
  }

  /**
   * One page of the consumer's endpoints.
   *
   * Returns the same `{ data, total, take, skip }` envelope as every other list
   * in this API (payment intents, swaps, customers, deliveries). It used to
   * return a bare array clamped at 100: a consumer with 120 endpoints got 100
   * of them with nothing in the response saying so, and no `total` to page
   * against — silent truncation of a list an integrator uses to decide which
   * endpoints to delete.
   */
  async findAll(
    consumer: GatewayConsumer,
    query: QueryEndpointsDto,
  ): Promise<{
    data: SafeWebhookEndpoint[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = { consumer: { apisixUsername: consumer.username } };
    // Promise.all rather than $transaction, matching findAll elsewhere: a
    // snapshot-consistent page and count buys nothing for a moving list and
    // costs two extra round trips.
    const [endpoints, total] = await Promise.all([
      this.prisma.webhookEndpoint.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
      }),
      this.prisma.webhookEndpoint.count({ where }),
    ]);
    return {
      data: endpoints.map((e) => this.strip(e)),
      total,
      take: query.take,
      skip: query.skip,
    };
  }

  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<SafeWebhookEndpoint> {
    return this.strip(await this.getOwned(consumer, id));
  }

  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdateWebhookEndpointDto,
  ): Promise<SafeWebhookEndpoint> {
    const current = await this.getOwned(consumer, id);
    if (dto.url !== undefined) {
      await this.assertUrlAllowed(dto.url);
    } else if (dto.enabled === true) {
      // Re-enable only when the stored URL still resolves to a public target.
      await this.assertUrlAllowed(current.url);
    }

    const clearBlock = dto.url !== undefined || dto.enabled === true;
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.eventTypes !== undefined ? { eventTypes: dto.eventTypes } : {}),
        ...(clearBlock ? { destinationBlocked: false } : {}),
      },
    });
    this.logger.log(`Updated webhook endpoint ${id} for ${consumer.username}`);
    return this.strip(updated);
  }

  async remove(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.getOwned(consumer, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    this.logger.log(`Deleted webhook endpoint ${id} for ${consumer.username}`);
    return { id, deleted: true };
  }

  /** Rotates the signing secret. Returns the endpoint WITH the new secret. */
  async rotateSecret(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<WebhookEndpoint> {
    await this.getOwned(consumer, id);
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { secret: this.generateSecret() },
    });
    this.logger.log(`Rotated secret for webhook endpoint ${id}`);
    return updated;
  }

  // ── Deliveries (traceability) ────────────────────────────────────────────────
  /**
   * The delivery log for one endpoint: what was sent, when, and how it went.
   *
   * `payload` is deliberately omitted. For a `RECEIVER_UPDATED` event it is the
   * BlindPay object verbatim — the complete KYC dossier, tax id, address and
   * bank details — and this route is gated on `webhooks:read`, not `kyc:read`.
   * Any key with the weaker scope could therefore read the full dossier of every
   * receiver the consumer had ever registered, indefinitely, by paging a
   * delivery log. The row still holds the body because a retry has to re-send
   * exactly what was signed; it just is not readable back through the API. The
   * integrator already received the body at their endpoint.
   */
  async listDeliveries(
    consumer: GatewayConsumer,
    id: string,
    query: QueryDeliveriesDto,
  ): Promise<{
    data: SafeWebhookDelivery[];
    total: number;
    take: number;
    skip: number;
  }> {
    await this.getOwned(consumer, id);
    const where = {
      endpointId: id,
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        omit: { payload: true },
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  /** Manually re-sends a past delivery (e.g. after the integrator was down). */
  async redeliver(
    consumer: GatewayConsumer,
    endpointId: string,
    deliveryId: string,
  ): Promise<SafeWebhookDelivery> {
    await this.getOwned(consumer, endpointId);
    // The body is loaded here — the dispatcher has to re-send exactly what was
    // signed — but it is stripped from the response for the same reason
    // listDeliveries omits it: this route is gated on `webhooks:read`, and a
    // RECEIVER_UPDATED body is a full KYC dossier.
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) {
      throw ApiError.notFound(`Delivery ${deliveryId} not found`);
    }
    // Past its retention window the body was replaced with a marker. Re-sending
    // it would deliver `{"redacted":true}` under a real event type with a valid
    // signature — worse than refusing, because a correct receiver would accept
    // it as the event. Say so rather than reporting a successful redelivery.
    if (isRedactedPayload(delivery.payload)) {
      throw ApiError.conflict(
        ApiErrorCode.PayloadExpired,
        `Delivery ${deliveryId} is past its retention window: the event body was ` +
          'cleared and can no longer be re-sent.',
      );
    }
    const { payload: _sentBody, ...safe } =
      await this.dispatcher.redeliver(delivery);
    return safe;
  }

  /** Sends a test event so integrators can verify their endpoint + signature. */
  async ping(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<{
    ok: boolean;
    responseStatus: number | null;
    error: string | null;
  }> {
    const endpoint = await this.getOwned(consumer, id);
    return this.dispatcher.pingEndpoint(endpoint);
  }

  /** Loads an endpoint or throws 404 unless it belongs to the consumer. */
  private async getOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!endpoint) {
      throw ApiError.notFound(`Webhook endpoint ${id} not found`);
    }
    return endpoint;
  }

  private async assertUrlAllowed(url: string): Promise<void> {
    try {
      await this.destinations.assertSafe(url);
    } catch (err) {
      if (err instanceof WebhookUrlValidationError) {
        throw ApiError.badRequest(ApiErrorCode.ValidationFailed, err.message);
      }
      throw err;
    }
  }
}
