import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from 'class-validator';

/**
 * Registers one of your users with Pollar ahead of their first login, so the
 * account exists before they ever see a consent screen.
 */
export class RegisterUserDto {
  @ApiProperty({
    example: 'usr_7Kd2',
    description: "Your own id for this user. Pollar's handle on them.",
  })
  @IsString()
  @Length(1, 255)
  external_id!: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: 'Ada' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  first_name?: string;

  @ApiPropertyOptional({ example: 'Lovelace' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  last_name?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/a/ada.png' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  avatar?: string;
}
