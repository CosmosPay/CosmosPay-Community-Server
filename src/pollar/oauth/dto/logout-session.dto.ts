import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Revokes the wallet's Pollar session. */
export class LogoutSessionDto {
  @ApiProperty({ description: 'The access token of the session to revoke.' })
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  access_token!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Revoke every device, not just this one.',
  })
  @IsOptional()
  @IsBoolean()
  everywhere?: boolean;
}
