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
 * A liquidity pool deposit request. The pair is given as the user knows it —
 * the service reorders it into the protocol's canonical order (assetA < assetB)
 * and remaps the amounts accordingly. Omit an asset code (or pass
 * "XLM"/"native") for native lumens; a non-native asset needs its issuer.
 */
export class DepositLiquidityDto {
  @ApiProperty({
    description: 'Account funding (and signing) the deposit — the tx source.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsStellarAddress()
  source!: string;

  @ApiPropertyOptional({
    description: 'First asset of the pair. Native if omitted.',
    example: 'XLM',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'assetACode must be 1-12 alphanumeric characters',
  })
  assetACode?: string;

  @ApiPropertyOptional({
    description: 'Issuer account for a non-native first asset.',
    example: 'GCRCUE2C5TBNIPYHMEP7NK5RWTT2WBSZ75CMARH7GDOHDDCQH3XANFOB',
  })
  @IsOptional()
  @IsStellarAddress()
  assetAIssuer?: string;

  @ApiPropertyOptional({
    description: 'Second asset of the pair. Native if omitted.',
    example: 'USDC',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'assetBCode must be 1-12 alphanumeric characters',
  })
  assetBCode?: string;

  @ApiPropertyOptional({
    description: 'Issuer account for a non-native second asset.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  @IsOptional()
  @IsStellarAddress()
  assetBIssuer?: string;

  @ApiProperty({
    description:
      'Maximum amount of the first asset to deposit (decimal, ≤ 7 places).',
    example: '1000',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message:
      'maxAmountA must be a positive decimal with up to 7 decimal places',
  })
  maxAmountA!: string;

  @ApiPropertyOptional({
    description:
      'Maximum amount of the second asset. When the pool already has ' +
      'reserves this is derived from the pool price if omitted; it is ' +
      'required when the pool is new or empty (the deposit sets the price).',
    example: '100',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message:
      'maxAmountB must be a positive decimal with up to 7 decimal places',
  })
  maxAmountB?: string;

  @ApiPropertyOptional({
    description:
      'Slippage tolerance in basis points (50 = 0.5%) used to derive the ' +
      'on-chain min/max price bounds. Defaults to the service setting; capped by it.',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  slippageBps?: number;

  @ApiPropertyOptional({
    description:
      'Optional MEMO_ID (numeric uint64) echoed on-chain for reconciliation.',
    example: '123456789',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'memo must be a numeric MEMO_ID (uint64)' })
  memo?: string;
}
