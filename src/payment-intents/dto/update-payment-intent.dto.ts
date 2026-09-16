import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaymentIntentStatus } from '@generated/prisma/client';
import { TX_HASH_RE } from '@/payment-intents/payment-intents.constants';

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
    description:
      'Hash of the Stellar transaction once the signed tx is submitted: 64 hex ' +
      'characters, stored lowercase. A hash already recorded on another of ' +
      'your payment intents is refused with 409 `idempotency_conflict`.',
    example: '3389e9f0d6b3e3f1c2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9',
    pattern: TX_HASH_RE.source,
  })
  @IsOptional()
  // Lowercased before it is validated and stored: Horizon reports hashes in
  // lowercase, and the (consumerId, txHash) index compares bytes, so `AB…` and
  // `ab…` would otherwise be two values for one transaction.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @Matches(TX_HASH_RE, {
    message: 'txHash must be a Stellar transaction hash: 64 hex characters',
  })
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
