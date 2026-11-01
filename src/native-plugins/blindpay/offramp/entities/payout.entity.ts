import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay payout (offramp, `pa_...`). */
@ApiSchema({ description: 'A payout (offramp) as this service mirrors it.' })
export class PayoutEntity {
  @ApiProperty({
    example: 'clz9xpayout001',
    description: 'Cosmos Pay id of the payout.',
  })
  id!: string;

  @ApiProperty({
    example: 'pa_000000000000',
    description: "BlindPay's payout id (`pa_...`).",
  })
  blindpayId!: string;

  @ApiPropertyOptional({
    example: 'processing',
    description:
      'BlindPay status of the payout (for example `processing`); `completed`, `failed`, `refunded` and `cancelled` mean the money stopped moving.',
  })
  status!: string | null;

  @ApiPropertyOptional({
    example: 'USDC',
    description: 'Stablecoin paid out (for example `USDC`).',
  })
  token!: string | null;

  @ApiPropertyOptional({
    example: 'base',
    description: 'Network the stablecoin is sent from (for example `base`).',
  })
  network!: string | null;

  @ApiPropertyOptional({
    example: 'ach',
    description: 'Bank rail the fiat settles on (for example `ach`).',
  })
  rail!: string | null;

  @ApiPropertyOptional({
    example: '10000',
    description: 'Amount of stablecoin sent, in minor units, as a string.',
  })
  senderAmount!: string | null;

  @ApiPropertyOptional({
    example: '9900',
    description:
      'Fiat amount the bank account receives, in minor units, as a string.',
  })
  receiverAmount!: string | null;

  @ApiPropertyOptional({
    example: '0x1234abcd...',
    description: 'Wallet the stablecoin is sent from.',
  })
  senderWalletAddress!: string | null;

  @ApiProperty({
    example: '2026-06-28T12:00:00.000Z',
    description: 'When this service recorded the payout (ISO 8601 date-time).',
  })
  createdAt!: Date;
}

/** One page of payouts — the envelope every list in this API returns. */
@ApiSchema({ description: "One page of the consumer's payouts, newest first." })
export class PayoutListEntity {
  @ApiProperty({
    type: [PayoutEntity],
    description: 'The payouts on this page.',
  })
  data!: PayoutEntity[];

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
