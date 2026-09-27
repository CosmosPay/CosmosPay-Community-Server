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

  @ApiProperty({
    example: 3,
    description:
      'Version of the submitted KYC data. Bumped on every edit while the receiver is still local. Send it back as `expected_version` when approving, so the approval is pinned to the dossier that was reviewed.',
  })
  dossierVersion!: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 3,
    description:
      'The `dossierVersion` an elevated reviewer approved, or null if the receiver has not been approved. Enabling is refused unless it equals `dossierVersion`.',
  })
  reviewedVersion!: number | null;

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

/** What approving a receiver hands back: the terms link it just sent. */
export class ReceiverApprovalEntity {
  @ApiProperty({
    description:
      'The hosted terms-of-service link, also emailed to the customer.',
    example:
      'https://app.blindpay.com/e/terms-of-service?session_token=tos_example',
  })
  url!: string;

  @ApiProperty({
    description:
      'Where the link was emailed, or null when the receiver has none.',
    example: 'customer@example.com',
    nullable: true,
    type: String,
  })
  email!: string | null;
}

/** A terms-of-service link, and how it reached the customer. */
export class ReceiverTosEntity extends ReceiverApprovalEntity {
  @ApiProperty({
    description:
      "`code` returns the link to show yourself; `email` also sent it to the receiver's address.",
    enum: ['code', 'email'],
    example: 'code',
  })
  channel!: 'code' | 'email';
}

export class ReceiverDeletedEntity {
  @ApiProperty({ example: 'clz9xreceiver01' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}
