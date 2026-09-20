import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  MinLength,
} from 'class-validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

export class CreatePrivateRfqDto {
  @ApiProperty({ example: 'rfq_procurement_2026_09' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  reference!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  @IsIn(['public', 'testnet'])
  network!: 'public' | 'testnet';

  @ApiProperty({
    example: 'CCOVGOQQZJKZ2R55GRWBLTJTGBAMSHXZVN3ICPG3WRVMLMM6RHISC5OV',
  })
  @Matches(/^C[A-Z2-7]{55}$/, {
    message: 'contractId must be a Stellar contract address',
  })
  contractId!: string;

  @ApiProperty({ example: '42', description: 'Sub Rosa u64 round id.' })
  @Matches(/^\d{1,20}$/, { message: 'roundId must be a decimal u64 string' })
  roundId!: string;

  @ApiPropertyOptional({ default: 'native', example: 'USDC' })
  @IsOptional()
  @IsString()
  @Matches(/^(native|[a-zA-Z0-9]{1,12})$/)
  assetCode?: string;

  @ApiPropertyOptional({ description: 'Required for non-native assets.' })
  @IsOptional()
  @IsStellarAddress()
  assetIssuer?: string;

  @ApiPropertyOptional({ default: 7, minimum: 0, maximum: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(7)
  assetDecimals?: number;
}
