import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { WebhookDeliveryStatus } from '@generated/prisma/client';

export class QueryDeliveriesDto {
  @ApiPropertyOptional({
    enum: WebhookDeliveryStatus,
    description: 'Only deliveries in this status. Omit for every status.',
  })
  @IsOptional()
  @IsEnum(WebhookDeliveryStatus)
  status?: WebhookDeliveryStatus;

  @ApiPropertyOptional({
    default: 20,
    maximum: 100,
    description: 'Page size: how many items to return (1 to 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({
    default: 0,
    description: 'How many items to skip before this page (offset).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
