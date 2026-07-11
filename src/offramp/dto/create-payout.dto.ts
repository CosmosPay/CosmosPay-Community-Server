import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  CHAIN_VARIANTS,
  type ChainVariant,
} from '../../blindpay/blindpay.constants';

/**
 * Executes an offramp from a quote. For EVM the customer must have already sent
 * the quote's `approve`; for Stellar/Solana, pass the `signed_transaction`
 * returned by the authorize step. The service never signs.
 */
export class CreatePayoutDto {
  @ApiProperty({ example: 'qe_000000000000' })
  @IsString()
  quote_id!: string;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  @IsString()
  sender_wallet_address!: string;

  @ApiProperty({ enum: CHAIN_VARIANTS, example: 'evm' })
  @IsIn(CHAIN_VARIANTS)
  chain!: ChainVariant;

  @ApiPropertyOptional({
    description:
      'Signed transaction (Stellar XDR / Solana tx) from the authorize step.',
  })
  @IsOptional()
  @IsString()
  signed_transaction?: string;
}
