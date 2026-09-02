import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay payout (offramp, `pa_...`). */
export class PayoutEntity {
  @ApiProperty({ example: 'clz9xpayout001' })
  id!: string;

  @ApiProperty({ example: 'pa_000000000000' })
  blindpayId!: string;

  @ApiPropertyOptional({ example: 'processing' })
  status!: string | null;

  @ApiPropertyOptional({ example: 'USDC' })
  token!: string | null;

  @ApiPropertyOptional({ example: 'base' })
  network!: string | null;

  @ApiPropertyOptional({ example: 'ach' })
  rail!: string | null;

  @ApiPropertyOptional({ example: '10000' })
  senderAmount!: string | null;

  @ApiPropertyOptional({ example: '9900' })
  receiverAmount!: string | null;

  @ApiPropertyOptional({
    example: '0x1234abcd...',
  })
  senderWalletAddress!: string | null;

  @ApiProperty({ example: '2026-06-28T12:00:00.000Z' })
  createdAt!: Date;
}

/** One page of payouts — the envelope every list in this API returns. */
export class PayoutListEntity {
  @ApiProperty({ type: [PayoutEntity] })
  data!: PayoutEntity[];

  @ApiProperty({
    description: 'Matching rows, not the page length.',
    example: 1,
  })
  total!: number;

  @ApiProperty({ example: 100 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
