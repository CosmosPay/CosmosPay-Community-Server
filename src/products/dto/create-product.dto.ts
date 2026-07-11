import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: 'Pro plan — monthly' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Full access, billed every month.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: '49.00',
    description:
      'Decimal price (≤ 7 decimals). Omit for a customer-set amount.',
  })
  @IsOptional()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a decimal string with up to 7 decimals',
  })
  amount?: string;

  @ApiPropertyOptional({
    example: 'USDC',
    description: 'Asset code the price is in. Omit for native lumens (XLM).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  assetCode?: string;

  @ApiPropertyOptional({
    enum: ['recurring', 'one_time', 'link'],
    default: 'one_time',
  })
  @IsOptional()
  @IsIn(['recurring', 'one_time', 'link'])
  kind?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ example: 'sku_pro_monthly' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
