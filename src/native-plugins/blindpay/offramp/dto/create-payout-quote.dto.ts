import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
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
} from '@/native-plugins/blindpay/blindpay.constants';

/**
 * Prices an offramp (stablecoin -> fiat). The quote expires in ~5 minutes and,
 * for EVM, carries a `contract` object the customer uses to sign the on-chain
 * `approve`. Amounts are integers in minor units.
 */
@ApiSchema({
  description:
    'A payout (stablecoin to fiat) to price to one of your bank accounts; the quote expires in about 5 minutes. Amounts are integers in minor units.',
})
export class CreatePayoutQuoteDto {
  @ApiProperty({
    example: 'clz9xbank00001',
    description:
      'Cosmos Pay bank account id (from POST /v1/kyc/receivers/:id/bank-accounts) that receives the fiat.',
  })
  @IsString()
  bank_account_id!: string;

  @ApiProperty({
    enum: CURRENCY_TYPES,
    example: 'sender',
    description:
      'Whether `request_amount` is what the sender sends (`sender`) or what the receiver receives (`receiver`).',
  })
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

  @ApiProperty({
    enum: BLINDPAY_NETWORKS,
    example: 'base',
    description: 'BlindPay network the stablecoin is sent on.',
  })
  @IsIn(BLINDPAY_NETWORKS)
  network!: BlindpayNetwork;

  @ApiProperty({
    enum: BLINDPAY_TOKENS,
    example: 'USDC',
    description:
      'Stablecoin paid out; `USDB` is the test token of the development instance.',
  })
  @IsIn(BLINDPAY_TOKENS)
  token!: BlindpayToken;

  @ApiPropertyOptional({
    description: 'Free-text description of the payout, forwarded to BlindPay.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'BlindPay partner fee id, forwarded as sent.',
  })
  @IsOptional()
  @IsString()
  partner_fee_id?: string;
}
