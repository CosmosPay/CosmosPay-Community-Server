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
 * A liquidity pool withdrawal: burn `shares` pool shares and receive the
 * proportional amounts of both reserves, protected by slippage-derived
 * on-chain minimums.
 */
export class WithdrawLiquidityDto {
  @ApiProperty({
    description:
      'Account holding the pool shares (and signing) — the tx source.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsStellarAddress()
  source!: string;

  @ApiProperty({
    description: 'Stellar liquidity pool id (64-char hex).',
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'poolId must be a 64-character lowercase hex liquidity pool id',
  })
  poolId!: string;

  @ApiProperty({
    description: 'Amount of pool shares to burn (decimal, ≤ 7 places).',
    example: '50',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'shares must be a positive decimal with up to 7 decimal places',
  })
  shares!: string;

  @ApiPropertyOptional({
    description:
      'Slippage tolerance in basis points (50 = 0.5%) used to derive the ' +
      'on-chain minimum received per reserve. Defaults to the service setting.',
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
