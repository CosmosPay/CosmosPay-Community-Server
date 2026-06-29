import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaymentIntentStatus } from '../../../generated/prisma/client';

/**
 * Advances the lifecycle of a stored payment intent (e.g. once the customer
 * submits the signed transaction). All fields optional so callers can patch
 * just the status, or attach the resulting Stellar tx hash.
 */
export class UpdatePaymentIntentDto {
  @ApiPropertyOptional({ enum: PaymentIntentStatus })
  @IsOptional()
  @IsEnum(PaymentIntentStatus)
  status?: PaymentIntentStatus;

  @ApiPropertyOptional({
    description: 'Stellar transaction hash once the signed tx is submitted.',
    example: '3389e9f0...',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  txHash?: string;

  @ApiPropertyOptional({
    description: 'Merchant reference.',
    example: 'order_1234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference?: string;
}
