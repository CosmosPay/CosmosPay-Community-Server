import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateWebhookEndpointDto } from '@/webhooks/dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from '@/webhooks/dto/update-webhook-endpoint.dto';
import { QueryDeliveriesDto } from '@/webhooks/dto/query-deliveries.dto';
import { QueryEndpointsDto } from '@/webhooks/dto/query-endpoints.dto';
import {
  WebhookDeletedEntity,
  WebhookDeliveryEntity,
  WebhookDeliveryListEntity,
  WebhookEndpointEntity,
  WebhookEndpointListEntity,
  WebhookEndpointWithSecretEntity,
  WebhookPingEntity,
} from '@/webhooks/entities/webhook.entity';
import {
  WEBHOOK_PING_RATE_LIMIT,
  WEBHOOK_REDELIVER_RATE_LIMIT,
} from '@/webhooks/webhooks.constants';
import { WebhooksService } from '@/webhooks/webhooks.service';

// URI versioning => /v1/webhooks
@ApiTags('webhooks')
@Controller({ path: 'webhooks', version: '1' })
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary:
      'Register a webhook endpoint (returns the signing secret, shown once)',
    description:
      '`url` must be `https`, carry no credentials and resolve to a public ' +
      'address (loopback, private, link-local and cloud metadata hosts are ' +
      '`400 validation_failed`). `secret` (`whsec_...`) is returned only here ' +
      'and on rotation: every delivery is signed with it in the signature ' +
      'header (`x-cosmos-signature` by default) as `t=<unix seconds>,v1=<hex ' +
      'HMAC-SHA256 of "<t>.<body>">`. An empty or omitted `eventTypes` ' +
      'receives every event type.',
  })
  @ApiCreatedResponse({ type: WebhookEndpointWithSecretEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateWebhookEndpointDto,
  ) {
    return this.webhooks.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('webhooks:read')
  @ApiOperation({
    summary: "List the consumer's webhook endpoints",
    description:
      'Newest first, as `{ data, total, take, skip }` with `take` up to 100 ' +
      '(default 100), without signing secrets. `destinationBlocked` marks an ' +
      'endpoint this service disabled because its host stopped resolving to a ' +
      'public address.',
  })
  @ApiOkResponse({ type: WebhookEndpointListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryEndpointsDto,
  ) {
    return this.webhooks.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('webhooks:read')
  @ApiOperation({
    summary: 'Get a webhook endpoint',
    description:
      'The endpoint without its signing secret, which only the create and ' +
      'rotate-secret routes return.',
  })
  @ApiOkResponse({ type: WebhookEndpointEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.webhooks.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary: 'Update a webhook endpoint (url/description/enabled/eventTypes)',
    description:
      'Changes only the fields sent. A new `url` is checked as on create, ' +
      '`enabled: true` checks the stored one again, and either clears ' +
      '`destinationBlocked`. `eventTypes` replaces the filter (an empty list ' +
      'receives every event type).',
  })
  @ApiOkResponse({ type: WebhookEndpointEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.webhooks.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary: 'Delete a webhook endpoint',
    description:
      'Deletes the endpoint together with its delivery history; nothing more ' +
      'is sent to it.',
  })
  @ApiOkResponse({ type: WebhookDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.webhooks.remove(consumer, id);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary: 'Rotate the signing secret (returns the new secret)',
    description:
      'Replaces `secret` at once and returns the new one, shown only here. ' +
      'Every delivery sent from now on is signed with the new secret only: ' +
      'the old one has no grace period.',
  })
  @ApiCreatedResponse({ type: WebhookEndpointWithSecretEntity })
  rotateSecret(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.webhooks.rotateSecret(consumer, id);
  }

  @Post(':id/ping')
  @RequirePermissions('webhooks:write')
  // One signed outbound request per call, to a URL the caller chose.
  @RateLimit(WEBHOOK_PING_RATE_LIMIT)
  @ApiOperation({
    summary: 'Send a test event to verify the endpoint',
    description:
      'POSTs one signed `ping` event (not stored as a delivery) to the ' +
      'endpoint, enabled or not, and answers whether it replied 2xx (`ok`, ' +
      '`responseStatus`, `error`). A URL that no longer resolves to a public ' +
      'address disables the endpoint and marks it `destinationBlocked`.',
  })
  @ApiCreatedResponse({ type: WebhookPingEntity })
  ping(@CurrentConsumer() consumer: GatewayConsumer, @Param('id') id: string) {
    return this.webhooks.ping(consumer, id);
  }

  @Get(':id/deliveries')
  @RequirePermissions('webhooks:read')
  @ApiOperation({
    summary: 'List delivery attempts for an endpoint (audit trail)',
    description:
      'Newest first, as `{ data, total, take, skip }` with `take` up to 100 ' +
      '(default 20), narrowed by `status` when given. Each delivery reports ' +
      'its `eventType`, `eventId`, `attempts`, last `responseStatus` and ' +
      '`error`; the event body that was sent is never returned.',
  })
  @ApiOkResponse({ type: WebhookDeliveryListEntity })
  listDeliveries(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Query() query: QueryDeliveriesDto,
  ) {
    return this.webhooks.listDeliveries(consumer, id, query);
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @RequirePermissions('webhooks:write')
  // Runs the retry loop inline: several outbound requests per call, with the
  // handler held through every timeout and backoff between them.
  @RateLimit(WEBHOOK_REDELIVER_RATE_LIMIT)
  @ApiOperation({
    summary: 'Manually re-send a past delivery',
    description:
      'Re-sends the stored body with the same event id, signed again with the ' +
      "endpoint's current secret, retrying with backoff inside this request " +
      'until a 2xx or the attempts run out, and answers the updated delivery ' +
      '(without its body). A delivery past its payload retention window is ' +
      '`409 payload_expired`.',
  })
  @ApiCreatedResponse({ type: WebhookDeliveryEntity })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.PayloadExpired],
    description:
      '`payload_expired`: the delivery is past its retention window. The ' +
      'event body was cleared, so there is nothing left to re-send; the ' +
      'delivery row itself stays as an audit record.',
  })
  redeliver(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhooks.redeliver(consumer, id, deliveryId);
  }
}
