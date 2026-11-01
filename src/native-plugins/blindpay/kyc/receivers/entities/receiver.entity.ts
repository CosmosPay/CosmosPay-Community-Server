import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/**
 * Cosmos Pay view of a BlindPay receiver. `id` is our local id; `blindpayId` is
 * BlindPay's `re_...`.
 *
 * This is the whole contract, and it is enforced rather than documented: the service
 * reads receivers through `RECEIVER_PUBLIC_SELECT`, whose field list is exactly the
 * properties below. The stored `raw` KYC dossier (tax ids, dates of birth, document and
 * selfie urls, beneficial owners) has no property here and never reaches a response.
 */
@ApiSchema({
  description:
    'A receiver as this service mirrors it; the submitted KYC dossier is never returned.',
})
export class ReceiverEntity {
  @ApiProperty({
    example: 'clz9xreceiver01',
    description:
      'Cosmos Pay id of the receiver, the `{id}` or `{receiverId}` of the receiver routes.',
  })
  id!: string;

  @ApiProperty({
    example: 're_000000000000',
    description:
      "BlindPay's receiver id (`re_...`); a `local_` placeholder until the receiver is enabled.",
  })
  blindpayId!: string;

  @ApiProperty({
    example: 'individual',
    description: '`individual` (KYC) or `business` (KYB).',
  })
  type!: string;

  @ApiPropertyOptional({
    example: 'standard',
    description:
      'Depth of compliance verification: `light`, `standard` or `enhanced`.',
  })
  kycType!: string | null;

  @ApiPropertyOptional({
    example: 'verifying',
    description: 'BlindPay KYC status (verifying, approved, rejected, ...).',
  })
  kycStatus!: string | null;

  @ApiPropertyOptional({
    example: 'jane@acme.com',
    description: "Receiver's email address.",
  })
  email!: string | null;

  @ApiPropertyOptional({
    example: 'Jane Doe',
    description:
      "Display name: a business's legal name, otherwise the person's first and last name.",
  })
  name!: string | null;

  @ApiPropertyOptional({
    example: 'US',
    description: "Receiver's country, an ISO 3166-1 alpha-2 code.",
  })
  country!: string | null;

  @ApiPropertyOptional({
    example: 'cust_001',
    description: 'Your own id for the receiver (`external_id`).',
  })
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

  @ApiProperty({
    example: '2026-06-28T12:00:00.000Z',
    description: 'When the receiver was created here (ISO 8601 date-time).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-28T12:00:00.000Z',
    description:
      'When the receiver was last changed here (ISO 8601 date-time).',
  })
  updatedAt!: Date;
}

/** One page of receivers — the envelope every list in this API returns. */
@ApiSchema({
  description: "One page of the consumer's receivers, newest first.",
})
export class ReceiverListEntity {
  @ApiProperty({
    type: [ReceiverEntity],
    description: 'The receivers on this page.',
  })
  data!: ReceiverEntity[];

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

/** What approving a receiver hands back: the terms link it just sent. */
@ApiSchema({
  description:
    'The terms-of-service link an approval requested, for the caller to deliver to the customer.',
})
export class ReceiverApprovalEntity {
  @ApiProperty({
    description:
      'The hosted terms-of-service link. This service emails nothing: deliver it to the customer.',
    example:
      'https://app.blindpay.com/e/terms-of-service?session_token=tos_example',
  })
  url!: string;

  @ApiProperty({
    description:
      "The receiver's email address, to deliver the link to, or null when the receiver has none.",
    example: 'customer@example.com',
    nullable: true,
    type: String,
  })
  email!: string | null;
}

/** A terms-of-service link, and how it reached the customer. */
@ApiSchema({
  description:
    'A terms-of-service link for a `pending_user` receiver, and the channel it was requested for.',
})
export class ReceiverTosEntity extends ReceiverApprovalEntity {
  @ApiProperty({
    description:
      '`code`: the link to show yourself. `email`: the send was recorded (once per 24 hours per receiver); you email the link.',
    enum: ['code', 'email'],
    example: 'code',
  })
  channel!: 'code' | 'email';
}

@ApiSchema({ description: 'Confirms a receiver deletion.' })
export class ReceiverDeletedEntity {
  @ApiProperty({
    example: 'clz9xreceiver01',
    description: 'The receiver id from the request path.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}
