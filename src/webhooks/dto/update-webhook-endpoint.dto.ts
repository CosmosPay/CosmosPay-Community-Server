import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { WebhookEventType } from '@generated/prisma/client';

@ApiSchema({
  description: 'Changes to a webhook endpoint; only the fields sent change.',
})
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({
    example: 'https://integrator.example.com/webhooks/cosmos',
    description: 'New https URL for deliveries, checked as on create.',
  })
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['https'],
  })
  url?: string;

  @ApiPropertyOptional({
    description: 'Free-text label for the endpoint (at most 255 characters).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'Pause/resume deliveries to this endpoint.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    enum: WebhookEventType,
    isArray: true,
    description:
      'Event types to subscribe to; replaces the current filter. An empty list receives every event type.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(WebhookEventType, { each: true })
  eventTypes?: WebhookEventType[];
}
