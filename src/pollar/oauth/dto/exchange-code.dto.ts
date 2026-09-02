import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

/** Redeems a single-use bridge code for the Pollar end-user session. */
export class ExchangeCodeDto {
  @ApiProperty({
    description:
      'The `code` the bridge delivered to the redirect URI, or returned by the poll route.',
    example: 'A0mQ1c2VycmV0LWNvZGUtdmFsdWUtaGVyZS1ub3QtcmVhbA',
  })
  @IsString()
  @Length(16, 256)
  code!: string;

  @ApiPropertyOptional({
    description:
      'PKCE verifier (RFC 7636). Required when the handshake was opened with a ' +
      '`code_challenge`, refused when it was not.',
    example: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  })
  @IsOptional()
  @IsString()
  @Length(43, 128)
  @Matches(/^[A-Za-z0-9._~-]+$/, {
    message: 'code_verifier must be RFC 7636 unreserved characters',
  })
  code_verifier?: string;
}
