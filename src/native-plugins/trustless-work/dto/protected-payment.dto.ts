import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ProtectedPaymentDeadlinePolicy,
  ProtectedPaymentReleaseModel,
  ProtectedPaymentStatus,
} from '@generated/prisma/client';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';
import {
  PROTECTED_PAYMENT_DEFAULT_FUNDING_HOURS,
  PROTECTED_PAYMENT_MAX_AMOUNT,
  PROTECTED_PAYMENT_MAX_DELIVERY_HOURS,
  PROTECTED_PAYMENT_MAX_DESCRIPTION,
  PROTECTED_PAYMENT_MAX_EVIDENCE,
  PROTECTED_PAYMENT_MAX_FUNDING_HOURS,
  PROTECTED_PAYMENT_MAX_REASON,
  PROTECTED_PAYMENT_MAX_REFERENCE,
  PROTECTED_PAYMENT_MAX_TITLE,
  PROTECTED_PAYMENT_MIN_AMOUNT,
  PROTECTED_PAYMENT_MIN_DELIVERY_HOURS,
} from '@/native-plugins/trustless-work/trustless-work.constants';

/** A USDC amount: a decimal with at most 7 places (Stellar's precision). */
const USDC_AMOUNT_RE = /^(0|[1-9]\d*)(\.\d{1,7})?$/;

const EXAMPLE_ACCOUNT =
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

@ApiSchema({
  description:
    'A protected payment to create: the buyer pays USDC into a Trustless Work ' +
    'contract and it is released to the merchant on the release model chosen here.',
})
export class CreateProtectedPaymentDto {
  @ApiProperty({
    example: '125.50',
    description:
      `The amount in USDC, a decimal with up to 7 places, from ` +
      `${PROTECTED_PAYMENT_MIN_AMOUNT} to ${PROTECTED_PAYMENT_MAX_AMOUNT}. The ` +
      'fees (1.95% by default) come out of what the merchant receives.',
  })
  @IsString()
  @Matches(USDC_AMOUNT_RE, {
    message: 'amount must be a decimal with at most 7 decimal places',
  })
  amount!: string;

  @ApiProperty({
    enum: ProtectedPaymentReleaseModel,
    description:
      'Who approves delivery and who releases the money: BUYER_RELEASES (the ' +
      'buyer approves and releases), MERCHANT_RELEASES (the merchant does both), ' +
      'BUYER_APPROVES_MERCHANT_RELEASES (the buyer approves, the merchant collects).',
  })
  @IsEnum(ProtectedPaymentReleaseModel)
  releaseModel!: ProtectedPaymentReleaseModel;

  @ApiProperty({
    enum: ProtectedPaymentDeadlinePolicy,
    description:
      'What happens when the delivery deadline passes on a funded payment that ' +
      'was not released: MANUAL_REVIEW (Cosmos Pay ops decides), REFUND_BUYER or ' +
      'RELEASE_MERCHANT (decided automatically).',
  })
  @IsEnum(ProtectedPaymentDeadlinePolicy)
  deadlinePolicy!: ProtectedPaymentDeadlinePolicy;

  @ApiProperty({
    minimum: PROTECTED_PAYMENT_MIN_DELIVERY_HOURS,
    maximum: PROTECTED_PAYMENT_MAX_DELIVERY_HOURS,
    example: 168,
    description:
      'Hours from funding until the delivery deadline (1 to 2160, 90 days).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(PROTECTED_PAYMENT_MIN_DELIVERY_HOURS)
  @Max(PROTECTED_PAYMENT_MAX_DELIVERY_HOURS)
  deliveryWindowHours!: number;

  @ApiPropertyOptional({
    default: PROTECTED_PAYMENT_DEFAULT_FUNDING_HOURS,
    minimum: 1,
    maximum: PROTECTED_PAYMENT_MAX_FUNDING_HOURS,
    description:
      'Hours the buyer has to fund it (1 to 720); unfunded after that, it expires.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROTECTED_PAYMENT_MAX_FUNDING_HOURS)
  fundingWindowHours?: number;

  @ApiProperty({
    example: EXAMPLE_ACCOUNT,
    description:
      'The Stellar account (G...) that receives the money. It must trust USDC.',
  })
  @IsStellarAddress()
  merchantAddress!: string;

  @ApiPropertyOptional({
    description:
      'The buyer’s Stellar account (G...), when the merchant knows it. Set, only ' +
      'this account may fund the payment; unset, the first account that funds it ' +
      'is bound as the buyer.',
  })
  @IsOptional()
  @IsStellarAddress()
  buyerAddress?: string;

  @ApiProperty({
    example: 'Order #1042',
    description: 'Shown to the buyer and written into the contract.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(PROTECTED_PAYMENT_MAX_TITLE)
  title!: string;

  @ApiPropertyOptional({
    description: 'Shown to the buyer and written into the contract.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PROTECTED_PAYMENT_MAX_DESCRIPTION)
  description?: string;

  @ApiPropertyOptional({
    description:
      'The merchant’s own reference. Never shown to the buyer, never on-chain.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PROTECTED_PAYMENT_MAX_REFERENCE)
  reference?: string;

  @ApiPropertyOptional({
    description:
      'Optional idempotency key. Prefer the `Idempotency-Key` header; the same key ' +
      'with the same request returns the stored payment, with another request it ' +
      'is 409 `idempotency_conflict`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}

export class QueryProtectedPaymentsDto {
  @ApiPropertyOptional({
    enum: ProtectedPaymentStatus,
    description: 'Only protected payments in this status.',
  })
  @IsOptional()
  @IsEnum(ProtectedPaymentStatus)
  status?: ProtectedPaymentStatus;

  @ApiPropertyOptional({
    default: 20,
    maximum: 100,
    description: 'How many to return per page (1 to 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({
    default: 0,
    description: 'How many to skip before the page starts (newest first).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}

export class ShipProtectedPaymentDto {
  @ApiProperty({
    example: 'DHL 1234567890',
    description:
      'What the payment shipped with: a tracking number or URL, written into ' +
      'the contract as the milestone’s evidence.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(PROTECTED_PAYMENT_MAX_EVIDENCE)
  evidence!: string;
}

export class DisputeProtectedPaymentDto {
  @ApiPropertyOptional({
    description:
      'Why, kept by Cosmos Pay for the review: Trustless Work V1 takes no reason.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PROTECTED_PAYMENT_MAX_REASON)
  reason?: string;
}

export class SubmitProtectedPaymentDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The protected payment the transaction was built for.',
  })
  @IsUUID()
  protectedPaymentId!: string;

  @ApiProperty({
    description:
      'The transaction a build on this service returned, signed unchanged (base64 envelope XDR).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  xdr!: string;
}

export class FundProtectedPaymentLinkDto {
  @ApiProperty({
    example: EXAMPLE_ACCOUNT,
    description:
      'The buyer’s Stellar account (G...): it signs the deposit and must hold the ' +
      'amount in USDC. The first fund binds it as the buyer.',
  })
  @IsStellarAddress()
  buyer!: string;
}

export class DisputeProtectedPaymentLinkDto extends DisputeProtectedPaymentDto {
  @ApiPropertyOptional({
    description:
      'Only when the buyer holds no role in the contract (`MERCHANT_RELEASES`): ' +
      'the buyer’s signature (base64) over `disputeChallenge.message` from the ' +
      'link’s read.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signature?: string;

  @ApiPropertyOptional({
    example: '2026-11-02T18:10:00.000Z',
    description:
      'With `signature`: `disputeChallenge.expiresAt`, exactly as it is in the signed message.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

export class SubmitProtectedPaymentLinkDto {
  @ApiProperty({
    description:
      'The transaction a build of this payment link returned, signed unchanged by the buyer (base64 envelope XDR).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  xdr!: string;
}

export class ResolveProtectedPaymentDto {
  @ApiProperty({
    example: '100',
    description: 'USDC to the buyer, before fees.',
  })
  @IsString()
  @Matches(USDC_AMOUNT_RE)
  buyerAmount!: string;

  @ApiProperty({
    example: '25.5',
    description: 'USDC to the merchant, before fees.',
  })
  @IsString()
  @Matches(USDC_AMOUNT_RE)
  merchantAmount!: string;
}
