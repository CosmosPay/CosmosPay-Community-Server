import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay bank account (`ba_...`). */
export class BankAccountEntity {
  @ApiProperty({ example: 'clz9xbank00001' })
  id!: string;

  @ApiProperty({ example: 'ba_000000000000' })
  blindpayId!: string;

  @ApiPropertyOptional({ example: 'ach' })
  rail!: string | null;

  @ApiPropertyOptional({ example: 'Acme payouts — USD' })
  name!: string | null;

  @ApiPropertyOptional({ example: 'US' })
  country!: string | null;

  @ApiProperty({ example: '2026-06-28T12:00:00.000Z' })
  createdAt!: Date;
}
