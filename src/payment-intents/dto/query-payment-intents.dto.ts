import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { PaymentIntentStatus } from '@generated/prisma/client';
import {
  PAYMENT_NETWORKS,
  type PaymentNetwork,
} from '@/payment-intents/payment-networks';

export class QueryPaymentIntentsDto {
  @ApiPropertyOptional({
    enum: PaymentIntentStatus,
    description: 'Only intents in this status. Omit for every status.',
  })
  @IsOptional()
  @IsEnum(PaymentIntentStatus)
  status?: PaymentIntentStatus;

  @ApiPropertyOptional({
    enum: PAYMENT_NETWORKS,
    description: 'Only intents on this network. Omit for every network.',
  })
  @IsOptional()
  @IsIn(PAYMENT_NETWORKS)
  chain?: PaymentNetwork;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Only intents created at or after this instant (ISO 8601). Omit for no lower bound. ' +
      'The dashboard uses it for its today / week / month / year views of the list.',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdFrom?: Date;

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
