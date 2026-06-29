import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import {
  BLINDPAY_NETWORKS,
  BLINDPAY_TOKENS,
  CURRENCY_TYPES,
  type BlindpayNetwork,
  type BlindpayToken,
  type CurrencyType,
} from '../../blindpay/blindpay.constants';

/**
 * Prices an offramp (stablecoin -> fiat). The quote expires in ~5 minutes and,
 * for EVM, carries a `contract` object the customer uses to sign the on-chain
 * `approve`. Amounts are integers in minor units.
 */
export class CreatePayoutQuoteDto {
  @ApiProperty({
    example: 'clz9xbank00001',
    description:
      'Cosmos Pay bank account id (from POST /v1/kyc/receivers/:id/bank-accounts) that receives the fiat.',
  })
  @IsString()
  bank_account_id!: string;

  @ApiProperty({ enum: CURRENCY_TYPES, example: 'sender' })
  @IsIn(CURRENCY_TYPES)
  currency_type!: CurrencyType;

  @ApiProperty({
    example: false,
    description: 'When true, the sender absorbs fees.',
  })
  @IsBoolean()
  cover_fees!: boolean;

  @ApiProperty({
    example: 10000,
    description: 'Amount in minor units (integer).',
  })
  @IsInt()
  @Min(1)
  request_amount!: number;

  @ApiProperty({ enum: BLINDPAY_NETWORKS, example: 'base' })
  @IsIn(BLINDPAY_NETWORKS)
  network!: BlindpayNetwork;

  @ApiProperty({ enum: BLINDPAY_TOKENS, example: 'USDC' })
  @IsIn(BLINDPAY_TOKENS)
  token!: BlindpayToken;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  partner_fee_id?: string;
}
