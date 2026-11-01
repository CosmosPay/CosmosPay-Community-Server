import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

@ApiSchema({
  description:
    'A catalog product to create. Creating one builds no payment link or intent.',
})
export class CreateProductDto {
  @ApiProperty({
    example: 'Pro plan (monthly)',
    description: 'Product name (1 to 120 characters).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: 'Full access, billed every month.',
    description:
      'Free-text description of the product (at most 500 characters).',
  })
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
    description:
      'Informational classification: `one_time` (default), `recurring` or `link`.',
  })
  @IsOptional()
  @IsIn(['recurring', 'one_time', 'link'])
  kind?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether the product is active. `false` retires it and keeps its record.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    example: 'sku_pro_monthly',
    description:
      'Your own SKU or reference for the product (at most 120 characters).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
