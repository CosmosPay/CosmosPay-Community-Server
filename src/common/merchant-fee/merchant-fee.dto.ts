import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_MERCHANT_FEE_PAYER,
  MAX_MERCHANT_FEE_BPS,
  MERCHANT_FEE_PAYERS,
  MERCHANT_FEE_WALLET_MAX_LENGTH,
  type MerchantFeePayer,
} from '@/common/merchant-fee/merchant-fee.constants';

/**
 * A merchant fee on one operation: a percentage, a fixed amount or both (as
 * Cosmos Pay's own plans price: 1% + 25¢), paid on-chain to `wallet`. The
 * wallet's shape and the fixed part's decimals depend on the operation, so the
 * service checks them once it knows the chain and the asset.
 */
@ApiSchema({
  description:
    'A merchant fee to charge on this operation: a percentage, a fixed amount or ' +
    'both, paid on-chain to `wallet`. At least one of `bps` and `fixed` must be above zero.',
})
export class MerchantFeeDto {
  @ApiPropertyOptional({
    description:
      `The percentage part, in basis points (150 = 1.5%), at most ${MAX_MERCHANT_FEE_BPS} (10%). ` +
      'Taken from `amount`, rounded down.',
    example: 150,
    minimum: 0,
    maximum: MAX_MERCHANT_FEE_BPS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MERCHANT_FEE_BPS)
  bps?: number;

  @ApiPropertyOptional({
    description:
      "The fixed part, in the operation's asset (a swap's source asset), as a " +
      "decimal with at most that asset's decimals. Added to the percentage part.",
    example: '0.25',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: 'fixed must be a non-negative decimal' })
  fixed?: string;

  @ApiProperty({
    description:
      'Where the fee is paid: an account on the chain the fee travels on (a ' +
      'Stellar G... account for a Stellar swap; a NEAR account for a swap ' +
      'between chains, which NEAR Intents pays as an app fee).',
    example: 'GBDHAQXQQ75WVBUZ2IX3O7ME7JOKJUOUPUXRNDCORUJODWQCTVUEQ62R',
    maxLength: MERCHANT_FEE_WALLET_MAX_LENGTH,
  })
  @IsString()
  @Matches(/\S/, { message: 'wallet must not be blank' })
  @MaxLength(MERCHANT_FEE_WALLET_MAX_LENGTH)
  wallet!: string;

  @ApiPropertyOptional({
    enum: MERCHANT_FEE_PAYERS,
    default: DEFAULT_MERCHANT_FEE_PAYER,
    description:
      '`recipient`: deducted from `amount` (the receiver gets less, a swap ' +
      'routes less). `payer`: added on top (the payer sends `amount` plus the fee).',
  })
  @IsOptional()
  @IsIn(MERCHANT_FEE_PAYERS)
  paidBy?: MerchantFeePayer;
}
