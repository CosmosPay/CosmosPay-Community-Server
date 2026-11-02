import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/**
 * A BlindPay payin quote. Pass-through (not persisted): use `id` to create the
 * payin before `expires_at` (~5 minutes). Extra provider fields are preserved.
 */
@ApiSchema({
  description:
    'A BlindPay payin quote, returned as BlindPay sent it (extra provider fields included); create the payin from `id` before `expires_at`.',
})
export class PayinQuoteEntity {
  @ApiProperty({
    example: 'pq_000000000000',
    description:
      'BlindPay quote id; pass it as `payin_quote_id` to `POST /v1/onramp/payins`.',
  })
  id!: string;

  @ApiProperty({
    example: 1782692400,
    description: 'Unix expiry (~5 min out).',
  })
  expires_at!: number;

  @ApiPropertyOptional({
    example: 5.42,
    description:
      "BlindPay's commercial quotation for this quote, passed through as it returned it.",
  })
  commercial_quotation?: number;

  @ApiPropertyOptional({
    example: 10000,
    description: 'Amount the receiver gets, in minor units.',
  })
  receiver_amount?: number;

  @ApiPropertyOptional({
    example: 10000,
    description: 'Amount the sender pays, in minor units.',
  })
  sender_amount?: number;
}
