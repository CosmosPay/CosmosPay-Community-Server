import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * What a wallet POSTs to a Solana Pay transaction request: the account that will
 * sign and pay (Solana Pay spec). Its shape is checked by the service, which
 * answers the wallet in its own words.
 */
export class SolanaPayAccountDto {
  @ApiProperty({
    description: 'The payer’s account (base58), which pays the fee and signs.',
    example: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  })
  @IsString()
  @MaxLength(64)
  account!: string;
}
