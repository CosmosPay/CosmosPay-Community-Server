import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { EVM_ADDRESS_PATTERN } from '@/p2p/dto/p2p-account.dto';
import {
  P2P_CURRENCY_CODES,
  P2P_MAX_INTEGRATOR_FEE_BPS,
  P2P_TEXT_MAX,
} from '@/p2p/p2p.constants';
import { P2P_NETWORK_IDS } from '@/p2p/p2p-networks';
import { P2P_ORDER_KINDS, P2P_ORDER_STATUSES } from '@/p2p/p2p-order-status';
import { P2P_RAIL_IDS } from '@/p2p/p2p-rails';

@ApiSchema({
  description:
    'What a person wants to trade. Give `fiatAmount` (local money) or `tokenAmount` (base units), not both.',
})
export class CreateP2pMarketQuoteDto {
  @ApiProperty({
    enum: ['BUY', 'SELL'],
    example: 'BUY',
    description:
      'BUY: the person receives tokens and pays local money. SELL: the person sends tokens and receives local money.',
  })
  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @ApiProperty({ enum: P2P_NETWORK_IDS, example: 'base' })
  @IsIn(P2P_NETWORK_IDS)
  network!: string;

  @ApiProperty({
    example: 'USDC',
    description: 'By contract address or symbol.',
  })
  @IsString()
  token!: string;

  @ApiProperty({ enum: P2P_CURRENCY_CODES, example: 'ARS' })
  @IsIn(P2P_CURRENCY_CODES)
  currency!: string;

  @ApiProperty({ enum: P2P_RAIL_IDS, example: 'ar_bank_transfer' })
  @IsIn(P2P_RAIL_IDS)
  rail!: string;

  @ApiPropertyOptional({
    example: '125050',
    description:
      'BUY: what the person pays. SELL: what the person receives. Up to the currency’s decimals.',
  })
  @IsOptional()
  @Matches(/^\d{1,15}(\.\d{1,2})?$/, {
    message: 'fiatAmount must be a positive decimal',
  })
  fiatAmount?: string;

  @ApiPropertyOptional({
    example: '100000000',
    description: 'The token amount the order locks, base units.',
  })
  @IsOptional()
  @Matches(/^[1-9]\d{0,37}$/, {
    message: 'tokenAmount must be a positive integer in base units',
  })
  tokenAmount?: string;

  @ApiPropertyOptional({
    example: 50,
    default: 0,
    minimum: 0,
    maximum: P2P_MAX_INTEGRATOR_FEE_BPS,
    description:
      'Your own fee on this order, basis points of what the buyer receives, paid to `integratorAccountId` on-chain.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(P2P_MAX_INTEGRATOR_FEE_BPS)
  integratorFeeBps?: number;

  @ApiPropertyOptional({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description:
      'The account your fee is paid to; required with a fee when you have more than one account.',
  })
  @IsOptional()
  @IsString()
  integratorAccountId?: string;
}

@ApiSchema({
  description:
    'Who pays the local money on a purchase: the merchant checks the transfer comes from this person.',
})
export class P2pMarketPayerDto {
  @ApiProperty({ example: 'Juan Gómez', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: '20123456786',
    description: 'Their identity document number.',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  document!: string;
}

@ApiSchema({
  description:
    'Where the merchant pays the local money on a sale or a payout: a holder, their document and the rail’s account details.',
})
export class P2pMarketBeneficiaryDto {
  @ApiProperty({ example: 'Ana López', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  holderName!: string;

  @ApiProperty({ example: '27234567891' })
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  document!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { cbu: '2850590940090418135201', cuit: '27234567891' },
    description: 'The rail’s fields, checked like a payment method’s.',
  })
  @IsObject()
  details!: Record<string, string>;
}

@ApiSchema({
  description:
    'An order from a quote. A purchase (BUY) needs `recipient` and `payer`; a sale (SELL) needs `seller` and `beneficiary`.',
})
export class CreateP2pMarketOrderDto {
  @ApiProperty({
    example: 'cm3p2pqte0001l70g8v5q3z2w',
    description: 'A quote of yours, not expired. One order per quote.',
  })
  @IsString()
  quoteId!: string;

  @ApiPropertyOptional({
    enum: ['BUY', 'SELL'],
    example: 'BUY',
    description: 'Optional; when given it must be the quote’s side.',
  })
  @IsOptional()
  @IsIn(['BUY', 'SELL'])
  kind?: 'BUY' | 'SELL';

  @ApiPropertyOptional({
    example: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    description: 'BUY: the wallet that receives the tokens.',
  })
  @IsOptional()
  @Matches(EVM_ADDRESS_PATTERN, { message: 'recipient must be an EVM address' })
  recipient?: string;

  @ApiPropertyOptional({
    type: P2pMarketPayerDto,
    description: 'BUY: required.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => P2pMarketPayerDto)
  payer?: P2pMarketPayerDto;

  @ApiPropertyOptional({
    example: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    description:
      'SELL: the wallet that holds the tokens and signs the two transactions. Refunds go back to it.',
  })
  @IsOptional()
  @Matches(EVM_ADDRESS_PATTERN, { message: 'seller must be an EVM address' })
  seller?: string;

  @ApiPropertyOptional({
    type: P2pMarketBeneficiaryDto,
    description: 'SELL: required.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => P2pMarketBeneficiaryDto)
  beneficiary?: P2pMarketBeneficiaryDto;

  @ApiPropertyOptional({ example: 'order-881', maxLength: P2P_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  externalReference?: string;
}

@ApiSchema({
  description:
    'The payment report: the transfer’s reference, when there is one.',
})
export class ReportP2pMarketPaidDto {
  @ApiPropertyOptional({ example: 'TRX-88213', maxLength: P2P_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  reference?: string;
}

export class QueryP2pMarketOrdersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: P2P_ORDER_STATUSES })
  @IsOptional()
  @IsIn(P2P_ORDER_STATUSES)
  status?: string;

  @ApiPropertyOptional({ enum: P2P_ORDER_KINDS })
  @IsOptional()
  @IsIn(P2P_ORDER_KINDS)
  kind?: string;

  @ApiPropertyOptional({
    example: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    description:
      'Only orders where this wallet is the buyer or the seller (any case).',
  })
  @IsOptional()
  @Matches(EVM_ADDRESS_PATTERN, { message: 'address must be an EVM address' })
  address?: string;
}
