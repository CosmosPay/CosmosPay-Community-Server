import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { P2pMarketBeneficiaryDto } from '@/p2p/dto/p2p-order.dto';
import {
  P2P_CURRENCY_CODES,
  P2P_PAYOUT_MAX_ITEMS,
  P2P_TEXT_MAX,
} from '@/p2p/p2p.constants';
import { P2P_NETWORK_IDS } from '@/p2p/p2p-networks';
import { P2P_RAIL_IDS } from '@/p2p/p2p-rails';

const FIAT = /^\d{1,15}(\.\d{1,2})?$/;

@ApiSchema({
  description:
    'A charge in local money: the payer pays it on the hosted page and the tokens go to `recipient`.',
})
export class CreateP2pMarketChargeDto {
  @ApiProperty({ enum: P2P_CURRENCY_CODES, example: 'ARS' })
  @IsIn(P2P_CURRENCY_CODES)
  currency!: string;

  @ApiProperty({
    example: '25000',
    description: 'Local money, up to the currency’s decimals.',
  })
  @Matches(FIAT, { message: 'fiatAmount must be a positive decimal' })
  fiatAmount!: string;

  @ApiProperty({ enum: P2P_NETWORK_IDS, example: 'base' })
  @IsIn(P2P_NETWORK_IDS)
  network!: string;

  @ApiProperty({
    example: 'USDC',
    description: 'By contract address or symbol.',
  })
  @IsString()
  token!: string;

  @ApiProperty({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description:
      'One of your registered accounts, by id or by address: where the tokens go.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  recipient!: string;

  @ApiPropertyOptional({ example: 'Order #881', maxLength: P2P_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  description?: string;

  @ApiPropertyOptional({
    example: '2026-11-20T12:00:00.000Z',
    description: 'Default: 24 hours from now. At most 30 days.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Let several payers pay it (each with one live order); otherwise it closes when paid.',
  })
  @IsOptional()
  @IsBoolean()
  multiUse?: boolean;
}

export class QueryP2pMarketChargesDto extends PaginationQueryDto {}

@ApiSchema({
  description:
    'Who pays a charge: the merchant checks the transfer comes from this person.',
})
export class P2pCheckoutPayerDto {
  @ApiProperty({ example: 'Juan Gómez', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '20123456786' })
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  document!: string;

  @ApiProperty({ example: 'juan@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

@ApiSchema({ description: 'The payer starts paying a charge on one rail.' })
export class CreateP2pCheckoutOrderDto {
  @ApiProperty({ enum: P2P_RAIL_IDS, example: 'ar_bank_transfer' })
  @IsIn(P2P_RAIL_IDS)
  rail!: string;

  @ApiProperty({ type: P2pCheckoutPayerDto })
  @ValidateNested()
  @Type(() => P2pCheckoutPayerDto)
  payer!: P2pCheckoutPayerDto;
}

@ApiSchema({
  description:
    'One payout: an amount of local money to a beneficiary on one rail.',
})
export class P2pMarketPayoutItemDto {
  @ApiProperty({ enum: P2P_CURRENCY_CODES, example: 'ARS' })
  @IsIn(P2P_CURRENCY_CODES)
  currency!: string;

  @ApiProperty({
    example: '50000',
    description: 'What the beneficiary receives, local money.',
  })
  @Matches(FIAT, { message: 'fiatAmount must be a positive decimal' })
  fiatAmount!: string;

  @ApiProperty({ enum: P2P_RAIL_IDS, example: 'ar_bank_transfer' })
  @IsIn(P2P_RAIL_IDS)
  rail!: string;

  @ApiProperty({ type: P2pMarketBeneficiaryDto })
  @ValidateNested()
  @Type(() => P2pMarketBeneficiaryDto)
  beneficiary!: P2pMarketBeneficiaryDto;

  @ApiPropertyOptional({
    example: 'payroll-2026-11-ana',
    maxLength: P2P_TEXT_MAX,
  })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  externalReference?: string;
}

@ApiSchema({
  description:
    'Payouts from your balance in the contract: each item is matched with a merchant and opened by the matcher on your balance.',
})
export class CreateP2pMarketPayoutDto {
  @ApiProperty({ enum: P2P_NETWORK_IDS, example: 'base' })
  @IsIn(P2P_NETWORK_IDS)
  network!: string;

  @ApiProperty({ example: 'USDC' })
  @IsString()
  token!: string;

  @ApiPropertyOptional({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description: 'The account paying out; optional when you have exactly one.',
  })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({
    type: [P2pMarketPayoutItemDto],
    maxItems: P2P_PAYOUT_MAX_ITEMS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(P2P_PAYOUT_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => P2pMarketPayoutItemDto)
  items!: P2pMarketPayoutItemDto[];
}

export class QueryP2pMarketPayoutsDto extends PaginationQueryDto {}
