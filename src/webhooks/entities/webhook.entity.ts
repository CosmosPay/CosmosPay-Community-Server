import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import {
  WebhookDeliveryStatus,
  WebhookEventType,
} from '@generated/prisma/client';

/** Endpoint without the secret — list/get responses. */
@ApiSchema({
  description:
    'A webhook endpoint of the consumer, without its signing secret.',
})
export class WebhookEndpointEntity {
  @ApiProperty({
    example: 'we_9z8a1b0000abcd1234efgh',
    description: 'Webhook endpoint id.',
  })
  id!: string;

  @ApiProperty({
    example: 'https://integrator.example.com/webhooks/cosmos',
    description: 'The https URL deliveries are POSTed to.',
  })
  url!: string;

  @ApiProperty({
    nullable: true,
    example: 'Production payment events',
    description: 'Free-text label for the endpoint; null when none was given.',
  })
  description!: string | null;

  @ApiProperty({
    example: true,
    description: 'Whether deliveries are sent to this endpoint.',
  })
  enabled!: boolean;

  @ApiProperty({
    example: false,
    description:
      'True when the URL failed public-destination checks (SSRF policy). Deliveries are skipped until the URL is updated to a safe https endpoint.',
  })
  destinationBlocked!: boolean;

  @ApiProperty({
    enum: WebhookEventType,
    isArray: true,
    example: ['PAYMENT_INTENT_SUCCEEDED'],
    description: 'Subscribed events; empty means all.',
  })
  eventTypes!: WebhookEventType[];

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the endpoint was registered (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the endpoint last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

/** Endpoint WITH the signing secret — returned only on create / rotate. */
@ApiSchema({
  description:
    'A webhook endpoint with its signing secret, returned only when it is created and when its secret is rotated.',
})
export class WebhookEndpointWithSecretEntity extends WebhookEndpointEntity {
  @ApiProperty({
    description: 'HMAC signing secret, shown once. Store it securely.',
    example: 'whsec_3f9a1c…',
  })
  secret!: string;
}

@ApiSchema({
  description:
    'One event delivery to a webhook endpoint, without the event body that was sent.',
})
export class WebhookDeliveryEntity {
  @ApiProperty({
    example: 'wd_9z8a1b0000abcd1234efgh',
    description: 'Delivery id.',
  })
  id!: string;

  @ApiProperty({
    example: 'we_9z8a1b0000abcd1234efgh',
    description: 'Id of the endpoint the event was sent to.',
  })
  endpointId!: string;

  @ApiProperty({
    enum: WebhookEventType,
    example: 'PAYMENT_INTENT_SUCCEEDED',
    description: 'Type of the event delivered.',
  })
  eventType!: WebhookEventType;

  @ApiProperty({
    example: 'evt_2c3d4e5f-aaaa-bbbb-cccc-1234567890ab',
    description:
      'Stable event id sent to the receiver (`x-cosmos-event-id`), for idempotency.',
  })
  eventId!: string;

  // `payload` is intentionally absent. The delivery row stores the signed body
  // so a retry can re-send it byte for byte, but it is never returned: a
  // RECEIVER_UPDATED body is the provider's full KYC dossier, and these routes
  // are gated on `webhooks:read` rather than `kyc:read`. The integrator
  // already received the body at their own endpoint.

  @ApiProperty({
    enum: WebhookDeliveryStatus,
    example: 'SUCCEEDED',
    description:
      'Delivery outcome: `PENDING` while it is being sent, `SUCCEEDED` once the endpoint answered 2xx, `FAILED` when no attempt did.',
  })
  status!: WebhookDeliveryStatus;

  @ApiProperty({
    example: 1,
    description: 'Number of POST attempts made so far.',
  })
  attempts!: number;

  @ApiProperty({
    nullable: true,
    example: 200,
    description:
      'HTTP status of the last attempt; null when it got no response.',
  })
  responseStatus!: number | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Why the last attempt failed (e.g. `Non-2xx response: 500`); null on success.',
  })
  error!: string | null;

  @ApiProperty({
    nullable: true,
    example: '2026-06-21T12:34:57.000Z',
    description:
      'When the last attempt was made (ISO 8601); null before the first.',
  })
  lastAttemptAt!: Date | null;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the delivery was created (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-21T12:34:57.000Z',
    description: 'When the delivery last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

@ApiSchema({
  description:
    "One page of the consumer's webhook endpoints, newest first, without signing secrets.",
})
export class WebhookEndpointListEntity {
  @ApiProperty({
    type: [WebhookEndpointEntity],
    description: 'The endpoints on this page, newest first.',
  })
  data!: WebhookEndpointEntity[];

  @ApiProperty({
    example: 1,
    description: 'Number of endpoints, across every page.',
  })
  total!: number;

  @ApiProperty({ example: 100, description: 'Page size applied (1 to 100).' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of endpoints skipped before this page.',
  })
  skip!: number;
}

@ApiSchema({
  description: "One page of an endpoint's delivery attempts, newest first.",
})
export class WebhookDeliveryListEntity {
  @ApiProperty({
    type: [WebhookDeliveryEntity],
    description: 'The deliveries on this page, newest first.',
  })
  data!: WebhookDeliveryEntity[];

  @ApiProperty({
    example: 1,
    description: 'Number of deliveries matching the filter, across every page.',
  })
  total!: number;

  @ApiProperty({ example: 20, description: 'Page size applied (1 to 100).' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of deliveries skipped before this page.',
  })
  skip!: number;
}

@ApiSchema({
  description:
    'Result of sending one signed test `ping` event to a webhook endpoint.',
})
export class WebhookPingEntity {
  @ApiProperty({
    example: true,
    description: 'True when the endpoint answered with a 2xx status.',
  })
  ok!: boolean;

  @ApiProperty({
    nullable: true,
    example: 200,
    description:
      'HTTP status the endpoint answered; null when the request got no response.',
  })
  responseStatus!: number | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Why the request failed when it got no response; null otherwise.',
  })
  error!: string | null;
}

@ApiSchema({
  description:
    'Confirmation that a webhook endpoint and its delivery history were deleted.',
})
export class WebhookDeletedEntity {
  @ApiProperty({
    example: 'we_9z8a1b0000abcd1234efgh',
    description: 'Id of the deleted endpoint.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}
