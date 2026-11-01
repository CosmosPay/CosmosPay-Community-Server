import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  BLINDPAY_TOKENS,
  type BlindpayToken,
} from '@/native-plugins/blindpay/blindpay.constants';

const BANKING_PARTNERS = ['jpmorgan', 'citi', 'hsbc', 'cfsb'] as const;

/**
 * Creates a virtual account: a dedicated fiat account in the receiver's name
 * that auto-converts incoming fiat into stablecoin to the linked wallet.
 */
@ApiSchema({
  description:
    'A virtual account to open for a receiver: a bank account in its name at `banking_partner` whose deposits are converted to `token` and sent to a wallet.',
})
export class CreateVirtualAccountDto {
  @ApiProperty({
    enum: BANKING_PARTNERS,
    example: 'cfsb',
    description: 'Bank the virtual account is opened at.',
  })
  @IsIn(BANKING_PARTNERS)
  banking_partner!: (typeof BANKING_PARTNERS)[number];

  @ApiProperty({
    enum: BLINDPAY_TOKENS,
    example: 'USDC',
    description:
      'Stablecoin the deposits are converted to; `USDB` is the test token of the development instance.',
  })
  @IsIn(BLINDPAY_TOKENS)
  token!: BlindpayToken;

  @ApiProperty({
    example: 'clz9xwallet001',
    description: 'Cosmos Pay wallet id that receives the converted stablecoin.',
  })
  @IsString()
  blockchain_wallet_id!: string;

  @ApiPropertyOptional({
    description: 'Id of a signed agreement, forwarded to BlindPay.',
  })
  @IsOptional()
  @IsString()
  signed_agreement_id?: string;

  @ApiPropertyOptional({
    description: 'Type of the sole-proprietor document, forwarded to BlindPay.',
  })
  @IsOptional()
  @IsString()
  sole_proprietor_doc_type?: string;

  @ApiPropertyOptional({
    description: 'Sole-proprietor document file, forwarded to BlindPay.',
  })
  @IsOptional()
  @IsString()
  sole_proprietor_doc_file?: string;
}
