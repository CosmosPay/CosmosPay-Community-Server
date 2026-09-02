import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cosmos Pay view of a BlindPay receiver. `id` is our local id; `blindpayId` is
 * BlindPay's `re_...`.
 *
 * This is the whole contract, and it is enforced rather than documented: the service
 * reads receivers through `RECEIVER_PUBLIC_SELECT`, whose field list is exactly the
 * properties below. The stored `raw` KYC dossier (tax ids, dates of birth, document and
 * selfie urls, beneficial owners) has no property here and never reaches a response.
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

/** One page of receivers — the envelope every list in this API returns. */
export class ReceiverListEntity {
  @ApiProperty({ type: [ReceiverEntity] })
  data!: ReceiverEntity[];

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
