import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay blockchain wallet (`bw_...`). */
export class WalletEntity {
  @ApiProperty({ example: 'clz9xwallet001' })
  id!: string;

  @ApiProperty({ example: 'bw_000000000000' })
  blindpayId!: string;

  @ApiPropertyOptional({ example: 'Primary wallet' })
  name!: string | null;

  @ApiProperty({ example: 'stellar' })
  network!: string;

  @ApiPropertyOptional({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  address!: string | null;

  @ApiProperty({ example: false })
  isAccountAbstraction!: boolean;

  @ApiProperty({ example: '2026-06-28T12:00:00.000Z' })
  createdAt!: Date;
}
