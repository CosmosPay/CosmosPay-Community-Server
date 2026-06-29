import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A BlindPay payin quote. Pass-through (not persisted): use `id` to create the
 * payin before `expires_at` (~5 minutes). Extra provider fields are preserved.
 */
export class PayinQuoteEntity {
  @ApiProperty({ example: 'pi_000000000000' })
  id!: string;

  @ApiProperty({
    example: 1782692400,
    description: 'Unix expiry (~5 min out).',
  })
  expires_at!: number;

  @ApiPropertyOptional({ example: 5.42 })
  commercial_quotation?: number;

  @ApiPropertyOptional({ example: 10000 })
  receiver_amount?: number;

  @ApiPropertyOptional({ example: 10000 })
  sender_amount?: number;
}
