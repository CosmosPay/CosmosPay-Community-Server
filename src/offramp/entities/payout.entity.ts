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
