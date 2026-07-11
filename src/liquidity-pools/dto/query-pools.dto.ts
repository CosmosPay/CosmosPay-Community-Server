import { ApiPropertyOptional } from '@nestjs/swagger';
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

/** Browse on-chain liquidity pools (proxied from Horizon; nothing persisted). */
export class QueryLiquidityPoolsDto {
  @ApiPropertyOptional({
    description:
      'Filter to pools containing this asset. Pass "XLM"/"native" for lumens.',
    example: 'USDC',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'assetACode must be 1-12 alphanumeric characters',
  })
  assetACode?: string;

  @ApiPropertyOptional({ description: 'Issuer for a non-native first asset.' })
  @IsOptional()
  @IsStellarAddress()
  assetAIssuer?: string;

  @ApiPropertyOptional({
    description: 'Second asset of the pair (narrows to the exact pool).',
    example: 'XLM',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'assetBCode must be 1-12 alphanumeric characters',
  })
  assetBCode?: string;

  @ApiPropertyOptional({ description: 'Issuer for a non-native second asset.' })
  @IsOptional()
  @IsStellarAddress()
  assetBIssuer?: string;

  @ApiPropertyOptional({
    description: 'Only pools this account participates in.',
  })
  @IsOptional()
  @IsStellarAddress()
  account?: string;

  @ApiPropertyOptional({ description: 'Horizon paging cursor.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
