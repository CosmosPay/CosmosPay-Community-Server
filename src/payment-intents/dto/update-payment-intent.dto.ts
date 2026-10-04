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
import { ANY_TX_ID_RE } from '@/payment-intents/payment-intents.constants';
import { lowercaseHexTxId } from '@/payment-intents/dto/validate-payment-intent.dto';

/**
 * Advances the lifecycle of a stored payment intent (e.g. once the customer
 * submits the signed transaction). All fields optional so callers can patch
 * just the status, or attach the resulting transaction id.
 */
export class UpdatePaymentIntentDto {
  @ApiPropertyOptional({ enum: PaymentIntentStatus })
  @IsOptional()
  @IsEnum(PaymentIntentStatus)
  status?: PaymentIntentStatus;

  @ApiPropertyOptional({
    description:
      'The transaction once it is submitted, in its chain’s own form: a ' +
      'Stellar hash (64 hex), a Solana signature (base58) or a Monad hash ' +
      '(0x + 64 hex). Hex is stored lowercase. A transaction already recorded ' +
      'on another of your payment intents is refused with 409 ' +
      '`idempotency_conflict`.',
    example: '3389e9f0d6b3e3f1c2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9',
    pattern: ANY_TX_ID_RE.source,
  })
  @IsOptional()
  // Hex is lowercased before it is validated and stored: Horizon and EVM nodes
  // report hashes in lowercase, and the (consumerId, txHash) index compares
  // bytes, so `AB…` and `ab…` would otherwise be two values for one
  // transaction. Base58 is case-sensitive and kept as sent.
  @Transform(lowercaseHexTxId)
  @IsString()
  @Matches(ANY_TX_ID_RE, {
    message:
      'txHash must be a transaction id: 64 hex characters (Stellar), a base58 ' +
      'signature (Solana) or 0x + 64 hex characters (Monad)',
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
