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
import { CHAINS, type Chain } from '@/chains/chains.constants';

export class QueryPaymentIntentsDto {
  @ApiPropertyOptional({ enum: PaymentIntentStatus })
  @IsOptional()
  @IsEnum(PaymentIntentStatus)
  status?: PaymentIntentStatus;

  @ApiPropertyOptional({
    enum: CHAINS,
    description: 'Only intents on this chain. Omit for every chain.',
  })
  @IsOptional()
  @IsIn(CHAINS)
  chain?: Chain;

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

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
