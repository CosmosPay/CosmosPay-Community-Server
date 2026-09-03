import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Trades a Pollar refresh token for a new pair. */
export class RefreshSessionDto {
  @ApiProperty({
    description:
      'The `refresh_token` from a previous exchange or refresh. Single-use: ' +
      'Pollar rotates it and rejects a reuse of the old one.',
  })
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  refresh_token!: string;
}
