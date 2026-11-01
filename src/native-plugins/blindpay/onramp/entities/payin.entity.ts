import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay payin (onramp, `pi_...`). */
@ApiSchema({
  description:
    'A payin (onramp) as this service mirrors it, with the instructions the payer follows to fund it.',
})
export class PayinEntity {
  @ApiProperty({
    example: 'clz9xpayin0001',
    description: 'Cosmos Pay id of the payin.',
  })
  id!: string;

  @ApiProperty({
    example: 'pi_000000000000',
    description: "BlindPay's payin id (`pi_...`).",
  })
  blindpayId!: string;

  @ApiPropertyOptional({
    example: 'processing',
    description:
      'BlindPay status of the payin (for example `processing`); `completed`, `failed`, `refunded` and `cancelled` mean the money stopped moving.',
  })
  status!: string | null;

  @ApiPropertyOptional({
    example: 'USDC',
    description: 'Stablecoin the payin delivers (for example `USDC`).',
  })
  token!: string | null;

  @ApiPropertyOptional({
    example: 'stellar',
    description:
      'Network the stablecoin is delivered on (for example `stellar`).',
  })
  network!: string | null;

  @ApiPropertyOptional({
    example: 'pix',
    description:
      'Fiat method the payer funds the payin with (for example `pix`).',
  })
  paymentMethod!: string | null;

  @ApiPropertyOptional({
    example: '10000',
    description: 'Amount the payer sends, in minor units, as a string.',
  })
  senderAmount!: string | null;

  @ApiPropertyOptional({
    example: '9950',
    description: 'Amount the wallet receives, in minor units, as a string.',
  })
  receiverAmount!: string | null;

  @ApiPropertyOptional({
    description:
      'Funding instructions for the payer (memo/CLABE/PIX/CBU/PSE/...).',
    example: { pix_code: '00020126...5204000053039865802BR...' },
  })
  instructions!: unknown;

  @ApiProperty({
    example: '2026-06-28T12:00:00.000Z',
    description: 'When this service recorded the payin (ISO 8601 date-time).',
  })
  createdAt!: Date;
}

/** One page of payins — the envelope every list in this API returns. */
@ApiSchema({ description: "One page of the consumer's payins, newest first." })
export class PayinListEntity {
  @ApiProperty({ type: [PayinEntity], description: 'The payins on this page.' })
  data!: PayinEntity[];

  @ApiProperty({
    description: 'Matching rows, not the page length.',
    example: 1,
  })
  total!: number;

  @ApiProperty({
    example: 100,
    description:
      'The page size applied, from the `take` query parameter (default 100).',
  })
  take!: number;

  @ApiProperty({
    example: 0,
    description:
      'Rows skipped before this page, from the `skip` query parameter (default 0).',
  })
  skip!: number;
}
