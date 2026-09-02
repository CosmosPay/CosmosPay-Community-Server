import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Checks a Pollar end-user access token server-side, with the secret key.
 *
 * This is how a backend trusts a token a wallet presents to it: the wallet is
 * not a trusted party, so its claim to be a given Pollar user is only worth what
 * Pollar says it is.
 */
export class VerifyTokenDto {
  @ApiProperty({ description: 'The end-user access token to validate.' })
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  token!: string;
}
