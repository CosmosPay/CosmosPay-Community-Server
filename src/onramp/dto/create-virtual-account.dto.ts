import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  BLINDPAY_TOKENS,
  type BlindpayToken,
} from '../../blindpay/blindpay.constants';

const BANKING_PARTNERS = ['jpmorgan', 'citi', 'hsbc', 'cfsb'] as const;

/**
 * Creates a virtual account: a dedicated fiat account in the receiver's name
 * that auto-converts incoming fiat into stablecoin to the linked wallet.
 */
export class CreateVirtualAccountDto {
  @ApiProperty({ enum: BANKING_PARTNERS, example: 'cfsb' })
  @IsIn(BANKING_PARTNERS)
  banking_partner!: (typeof BANKING_PARTNERS)[number];

  @ApiProperty({ enum: BLINDPAY_TOKENS, example: 'USDC' })
  @IsIn(BLINDPAY_TOKENS)
  token!: BlindpayToken;

  @ApiProperty({
    example: 'clz9xwallet001',
    description: 'Cosmos Pay wallet id that receives the converted stablecoin.',
  })
  @IsString()
  blockchain_wallet_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signed_agreement_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sole_proprietor_doc_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sole_proprietor_doc_file?: string;
}
