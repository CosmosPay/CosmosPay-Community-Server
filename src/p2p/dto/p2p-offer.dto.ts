import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  P2P_CURRENCY_CODES,
  P2P_MAX_PRICE_TTL_SECONDS,
} from '@/p2p/p2p.constants';
import { P2P_NETWORK_IDS } from '@/p2p/p2p-networks';
import { P2P_RAIL_IDS } from '@/p2p/p2p-rails';

const DECIMAL = /^\d{1,18}(\.\d{1,6})?$/;

@ApiSchema({
  description:
    'A merchant’s standing price. Its bot refreshes `price` (a PATCH) before `priceTtlSeconds` runs out, or the offer stops matching.',
})
export class CreateP2pMarketOfferDto {
  @ApiProperty({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description: 'The merchant account; it needs a `displayName`.',
  })
  @IsString()
  accountId!: string;

  @ApiProperty({
    enum: ['SELL_TOKEN', 'BUY_TOKEN'],
    example: 'SELL_TOKEN',
    description:
      'SELL_TOKEN: you sell tokens from your balance in the contract (authorise the matcher for it). BUY_TOKEN: you buy tokens, accepting each order with a bond from your balance.',
  })
  @IsIn(['SELL_TOKEN', 'BUY_TOKEN'])
  side!: 'SELL_TOKEN' | 'BUY_TOKEN';

  @ApiProperty({ enum: P2P_NETWORK_IDS, example: 'base' })
  @IsIn(P2P_NETWORK_IDS)
  network!: string;

  @ApiProperty({
    example: 'USDC',
    description:
      'The token, by contract address or symbol (as `GET /v1/p2p/market` lists it).',
  })
  @IsString()
  token!: string;

  @ApiProperty({ enum: P2P_CURRENCY_CODES, example: 'ARS' })
  @IsIn(P2P_CURRENCY_CODES)
  currency!: string;

  @ApiProperty({
    enum: P2P_RAIL_IDS,
    isArray: true,
    example: ['ar_bank_transfer'],
    description:
      'Rails of the currency you take. A SELL_TOKEN offer needs an active payment method on each.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(P2P_RAIL_IDS.length)
  @IsIn(P2P_RAIL_IDS, { each: true })
  rails!: string[];

  @ApiProperty({
    example: '1250.5',
    description: 'Local money per one token, up to 6 decimals.',
  })
  @Matches(DECIMAL, {
    message: 'price must be a positive decimal with at most 6 places',
  })
  price!: string;

  @ApiPropertyOptional({
    example: 600,
    default: 600,
    minimum: 30,
    maximum: P2P_MAX_PRICE_TTL_SECONDS,
    description: 'Seconds the price stays matchable after each update.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(P2P_MAX_PRICE_TTL_SECONDS)
  priceTtlSeconds?: number;

  @ApiProperty({
    example: '5000',
    description: 'Smallest order in local money.',
  })
  @Matches(DECIMAL, { message: 'minFiat must be a positive decimal' })
  minFiat!: string;

  @ApiProperty({
    example: '500000',
    description: 'Largest order in local money.',
  })
  @Matches(DECIMAL, { message: 'maxFiat must be a positive decimal' })
  maxFiat!: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@ApiSchema({
  description:
    'What may change on an offer. A new `price` restarts its lifetime; side, network, token and currency never change.',
})
export class UpdateP2pMarketOfferDto {
  @ApiPropertyOptional({ example: '1251.2' })
  @IsOptional()
  @Matches(DECIMAL, {
    message: 'price must be a positive decimal with at most 6 places',
  })
  price?: string;

  @ApiPropertyOptional({
    example: 600,
    minimum: 30,
    maximum: P2P_MAX_PRICE_TTL_SECONDS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(P2P_MAX_PRICE_TTL_SECONDS)
  priceTtlSeconds?: number;

  @ApiPropertyOptional({
    enum: P2P_RAIL_IDS,
    isArray: true,
    example: ['ar_bank_transfer'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(P2P_RAIL_IDS.length)
  @IsIn(P2P_RAIL_IDS, { each: true })
  rails?: string[];

  @ApiPropertyOptional({ example: '5000' })
  @IsOptional()
  @Matches(DECIMAL, { message: 'minFiat must be a positive decimal' })
  minFiat?: string;

  @ApiPropertyOptional({ example: '500000' })
  @IsOptional()
  @Matches(DECIMAL, { message: 'maxFiat must be a positive decimal' })
  maxFiat?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class QueryP2pMarketOffersDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description: 'Only this account’s.',
  })
  @IsOptional()
  @IsString()
  accountId?: string;
}
