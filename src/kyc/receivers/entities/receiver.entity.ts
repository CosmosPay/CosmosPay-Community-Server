import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cosmos Pay view of a BlindPay receiver. `id` is our local id; `blindpayId` is
 * BlindPay's `re_...`. `raw` carries the full provider object.
 */
export class ReceiverEntity {
  @ApiProperty({ example: 'clz9xreceiver01' })
  id!: string;

  @ApiProperty({ example: 're_000000000000' })
  blindpayId!: string;

  @ApiProperty({ example: 'individual' })
  type!: string;

  @ApiPropertyOptional({ example: 'standard' })
  kycType!: string | null;

  @ApiPropertyOptional({
    example: 'verifying',
    description: 'BlindPay KYC status (verifying, approved, rejected, ...).',
  })
  kycStatus!: string | null;

  @ApiPropertyOptional({ example: 'jane@acme.com' })
  email!: string | null;

  @ApiPropertyOptional({ example: 'Jane Doe' })
  name!: string | null;

  @ApiPropertyOptional({ example: 'US' })
  country!: string | null;

  @ApiPropertyOptional({ example: 'cust_001' })
  externalId!: string | null;

  @ApiProperty({
    example: false,
    description:
      'Owner/admin kill-switch: when true the account is blocked from onramp/offramp.',
  })
  disabled!: boolean;

  @ApiProperty({ example: '2026-06-28T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-28T12:00:00.000Z' })
  updatedAt!: Date;
}
