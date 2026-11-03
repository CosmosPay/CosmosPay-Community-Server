import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  ProtectedPaymentAction,
  ProtectedPaymentDeadlinePolicy,
  ProtectedPaymentReleaseModel,
  ProtectedPaymentStatus,
} from '@generated/prisma/client';

const ACCOUNT = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const TX_HASH =
  '5f0e8a1d3c7b9e2f4a6c8d0b1e3f5a7c9d2b4e6f8a0c1d3e5f7a9b2c4d6e8f0a';

@ApiSchema({
  description:
    'What the fees take: Trustless Work’s fixed 0.30% and Cosmos Pay’s share, ' +
    'deducted on-chain from a release and from each part of a dispute resolution.',
})
export class ProtectedPaymentFeesEntity {
  @ApiProperty({
    example: 30,
    description: 'Trustless Work’s fee, in basis points.',
  })
  trustlessWorkBps!: number;

  @ApiProperty({
    example: 165,
    description: 'Cosmos Pay’s fee, in basis points.',
  })
  platformBps!: number;

  @ApiProperty({ example: 195, description: 'Both fees, in basis points.' })
  totalBps!: number;

  @ApiProperty({
    example: '123.05275',
    description:
      'What the merchant receives on a release, in USDC, after both fees.',
  })
  merchantReceives!: string;
}

/** The fields the merchant's and the buyer's views share. */
class ProtectedPaymentBaseEntity {
  @ApiProperty({ example: ID, format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  network!: string;

  @ApiProperty({ enum: ProtectedPaymentStatus })
  status!: ProtectedPaymentStatus;

  @ApiProperty({ enum: ProtectedPaymentReleaseModel })
  releaseModel!: ProtectedPaymentReleaseModel;

  @ApiProperty({ enum: ProtectedPaymentDeadlinePolicy })
  deadlinePolicy!: ProtectedPaymentDeadlinePolicy;

  @ApiProperty({ example: 'Order #1042' })
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ example: '125.5', description: 'In USDC, up to 7 decimals.' })
  amount!: string;

  @ApiProperty({ example: 'USDC' })
  asset!: string;

  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  assetIssuer!: string;

  @ApiProperty({ example: ACCOUNT, description: 'Receives the money.' })
  merchantAddress!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Named by the merchant, or bound by the first fund.',
  })
  buyerAddress!: string | null;

  @ApiProperty({
    example: 165,
    description: 'Cosmos Pay’s fee, in basis points.',
  })
  platformFeeBps!: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: CONTRACT,
    description:
      'The Trustless Work contract (C...), once deployed by the first fund.',
  })
  contractId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  fundingExpiresAt!: Date;

  @ApiProperty({ example: 168 })
  deliveryWindowHours!: number;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Funding time plus `deliveryWindowHours`.',
  })
  deliveryDeadlineAt!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  deadlinePassedAt!: Date | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'What the merchant shipped with (tracking number or URL).',
  })
  evidence!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  fundedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  shippedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  approvedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  releasedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  disputedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  resolvedAt!: Date | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { buyer: '100', merchant: '25.5', decidedBy: 'ops@cosmospay.lat' },
    description: 'How a dispute split the balance, in USDC before fees.',
  })
  resolution!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  cancelledAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: ProtectedPaymentFeesEntity })
  fees!: ProtectedPaymentFeesEntity;
}

@ApiSchema({
  description:
    'A protected payment as its merchant reads it: the row this service keeps, ' +
    'mirrored from the Trustless Work contract by the sync job.',
})
export class ProtectedPaymentEntity extends ProtectedPaymentBaseEntity {
  @ApiProperty({ nullable: true, type: String })
  reference!: string | null;

  @ApiProperty({
    example: ACCOUNT,
    description: 'Cosmos Pay’s platform account.',
  })
  platformAddress!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The dispute resolver the contract names (ops or the automatic resolver).',
  })
  disputeResolverAddress!: string | null;

  @ApiProperty({
    nullable: true,
    enum: ['BUYER', 'MERCHANT', 'DEADLINE'],
    type: String,
  })
  disputedBy!: string | null;

  @ApiProperty({ nullable: true, type: String })
  disputeReason!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastSyncedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({
    example: `https://payments.cosmospay.lat/protected/${ID}`,
    description:
      'The buyer’s page for this payment: send this link to the buyer.',
  })
  checkoutUrl!: string;
}

export class ProtectedPaymentListEntity {
  @ApiProperty({ type: [ProtectedPaymentEntity] })
  data!: ProtectedPaymentEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

@ApiSchema({
  description:
    'The message a buyer without an on-chain role signs to have the platform open a dispute.',
})
export class ProtectedPaymentDisputeChallengeEntity {
  @ApiProperty({
    example:
      `Cosmos Pay protected payment dispute\npayment: ${ID}\naccount: ${ACCOUNT}\n` +
      'network: testnet\nexpires: 2026-11-02T18:10:00.000Z',
  })
  message!: string;

  @ApiProperty({ example: '2026-11-02T18:10:00.000Z' })
  expiresAt!: string;
}

@ApiSchema({
  description:
    'A protected payment as its buyer sees it on the payment link, read without an API key.',
})
export class ProtectedPaymentLinkEntity extends ProtectedPaymentBaseEntity {
  @ApiProperty({
    type: [String],
    enum: ['fund', 'approve', 'release', 'dispute'],
    example: ['fund'],
    description:
      'What the buyer can do now, by the status and the release model.',
  })
  buyerActions!: string[];

  @ApiProperty({
    type: ProtectedPaymentDisputeChallengeEntity,
    nullable: true,
    description:
      'Only when the buyer may dispute and holds no role in the contract ' +
      '(`MERCHANT_RELEASES`): sign `message` with the buyer’s key and send it to dispute.',
  })
  disputeChallenge!: ProtectedPaymentDisputeChallengeEntity | null;
}

/** The fields of a built transaction, shared by both views. */
class ProtectedPaymentBuildBase {
  @ApiProperty({ enum: ProtectedPaymentAction })
  action!: ProtectedPaymentAction;

  @ApiProperty({
    example: 'AAAAAgAAAAB…',
    description:
      'The unsigned transaction (base64 envelope XDR), checked to be exactly the ' +
      'requested call. Sign it unchanged and send it to the submit route.',
  })
  xdr!: string;

  @ApiProperty({ example: TX_HASH })
  txHash!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Submit it before this (15 minutes at most).',
  })
  expiresAt!: Date;
}

export class ProtectedPaymentBuildEntity extends ProtectedPaymentBuildBase {
  @ApiProperty({ type: ProtectedPaymentEntity })
  protectedPayment!: ProtectedPaymentEntity;
}

export class ProtectedPaymentLinkBuildEntity extends ProtectedPaymentBuildBase {
  @ApiProperty({ type: ProtectedPaymentLinkEntity })
  protectedPayment!: ProtectedPaymentLinkEntity;
}

/** The fields of a relayed transaction, shared by both views. */
class ProtectedPaymentSubmitBase {
  @ApiProperty({ enum: ProtectedPaymentAction })
  action!: ProtectedPaymentAction;

  @ApiProperty({ example: TX_HASH })
  txHash!: string;

  @ApiProperty({
    example: 'SUCCESS',
    description:
      'Trustless Work’s answer: `SUCCESS` (the payment moved), or `FAILED`.',
  })
  status!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example:
      'The transaction has been successfully sent to the Stellar network.',
  })
  message!: string | null;
}

export class ProtectedPaymentSubmitEntity extends ProtectedPaymentSubmitBase {
  @ApiProperty({ type: ProtectedPaymentEntity })
  protectedPayment!: ProtectedPaymentEntity;
}

export class ProtectedPaymentLinkSubmitEntity extends ProtectedPaymentSubmitBase {
  @ApiProperty({ type: ProtectedPaymentLinkEntity })
  protectedPayment!: ProtectedPaymentLinkEntity;
}

@ApiSchema({
  description:
    'A buyer’s dispute: an envelope to sign (`built`) when the buyer holds a role ' +
    'in the contract, or the dispute the platform opened (`submitted`) when it does not.',
})
export class ProtectedPaymentLinkDisputeEntity {
  @ApiPropertyOptional({
    type: ProtectedPaymentLinkBuildEntity,
    nullable: true,
  })
  built!: ProtectedPaymentLinkBuildEntity | null;

  @ApiPropertyOptional({
    type: ProtectedPaymentLinkSubmitEntity,
    nullable: true,
  })
  submitted!: ProtectedPaymentLinkSubmitEntity | null;
}
