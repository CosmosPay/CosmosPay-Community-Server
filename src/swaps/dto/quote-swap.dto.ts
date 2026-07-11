import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';

/**
 * A swap quote request: how much of which asset you want to sell (`amount` of the
 * source asset) and which asset you want to buy. The service prices it through
 * Horizon's strict-send path search over the DEX + AMM pools. Omit an asset code
 * (or pass "XLM"/"native") for native lumens; a non-native asset needs its issuer.
 */
export class QuoteSwapDto {
  @ApiPropertyOptional({
    description: 'Source asset code (the asset being sold). Native if omitted.',
    example: 'XLM',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'sourceAssetCode must be 1-12 alphanumeric characters',
  })
  sourceAssetCode?: string;

  @ApiPropertyOptional({
    description: 'Issuer account for a non-native source asset.',
    example: 'GCRCUE2C5TBNIPYHMEP7NK5RWTT2WBSZ75CMARH7GDOHDDCQH3XANFOB',
  })
  @IsOptional()
  @IsStellarAddress()
  sourceAssetIssuer?: string;

  @ApiProperty({
    description:
      'Gross amount of the source asset to swap (decimal, ≤ 7 places). ' +
      'The platform fee is deducted from this and the remainder is routed.',
    example: '100',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a positive decimal with up to 7 decimal places',
  })
  amount!: string;

  @ApiProperty({
    description: 'Destination asset code (the asset being bought).',
    example: 'USDC',
  })
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'destAssetCode must be 1-12 alphanumeric characters',
  })
  destAssetCode!: string;

  @ApiPropertyOptional({
    description:
      'Issuer account for the destination asset (required unless it is native).',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  @IsOptional()
  @IsStellarAddress()
  destAssetIssuer?: string;

  @ApiPropertyOptional({
    description:
      'Slippage tolerance in basis points (50 = 0.5%) used to derive the ' +
      'on-chain minimum received. Defaults to the service setting; capped by it.',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  slippageBps?: number;
}
