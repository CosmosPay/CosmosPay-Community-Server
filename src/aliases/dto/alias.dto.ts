import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AliasChallengePurpose } from '@generated/prisma/client';
import { ALIAS_MAX_LENGTH, ALIAS_MIN_LENGTH } from '@/aliases/alias-name';
import { ALIAS_PAGE_SIZE } from '@/aliases/aliases.constants';

/** The purposes a client may ask for. `RECOVER` is issued by the recovery flow. */
export const ALIAS_CLIENT_PURPOSES = ['CLAIM', 'ADD_ADDRESS', 'RECOVER'];

/**
 * Stellar public keys are 56 base32 characters opening with `G`. Validated here
 * as SHAPE only — `alias-signing.ts` decodes and checksums it. Two layers,
 * because a shape check gives a clean 400 with a field name, and the decode gives
 * the guarantee.
 */
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

export class CreateAliasChallengeDto {
  @ApiProperty({
    example: 'emanuel250',
    description: 'The handle being claimed.',
  })
  @IsString()
  @MinLength(ALIAS_MIN_LENGTH)
  @MaxLength(ALIAS_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'address must be a Stellar public key (G…)',
  })
  address!: string;

  @ApiProperty({
    example: 'public',
    description: 'Network id: public | testnet | a custom id.',
  })
  @IsString()
  @MaxLength(40)
  network!: string;

  @ApiPropertyOptional({ enum: ALIAS_CLIENT_PURPOSES, default: 'CLAIM' })
  @IsOptional()
  @IsIn(ALIAS_CLIENT_PURPOSES)
  purpose?: AliasChallengePurpose;
}

export class ClaimAliasDto {
  @ApiProperty({ example: 'emanuel250' })
  @IsString()
  @MinLength(ALIAS_MIN_LENGTH)
  @MaxLength(ALIAS_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    description:
      'Recovery mailbox. Required at claim time, not later: an alias whose owner ' +
      'loses their key before adding one is unrecoverable, and that is the state ' +
      'this field exists to prevent.',
    example: 'someone@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ description: 'The nonce from POST /v1/aliases/challenges.' })
  @IsString()
  @MaxLength(128)
  nonce!: string;

  @ApiProperty({ description: 'base64 ed25519 over the challenge digest.' })
  @IsString()
  @MaxLength(200)
  signature!: string;

  @ApiPropertyOptional({
    description: 'Human label for this first address.',
    example: 'phone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class AddAliasAddressDto {
  @ApiProperty()
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'address must be a Stellar public key (G…)',
  })
  address!: string;

  @ApiProperty({ example: 'testnet' })
  @IsString()
  @MaxLength(40)
  network!: string;

  @ApiProperty({ description: 'The nonce from an ADD_ADDRESS challenge.' })
  @IsString()
  @MaxLength(128)
  nonce!: string;

  @ApiProperty({ description: 'base64 ed25519 over the challenge digest.' })
  @IsString()
  @MaxLength(200)
  signature!: string;

  @ApiPropertyOptional({ example: 'cold wallet' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({
    description:
      'Make this the address a payer gets when they do not ask for a specific ' +
      'one on this network. Exactly one address per network is primary.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  primary?: boolean;
}

export class StartAliasRecoveryDto {
  @ApiProperty({
    description:
      'The mailbox on record. Checked but never echoed: the response is identical ' +
      'whether or not it matched, so this endpoint cannot be used to ask which ' +
      'address owns a handle.',
    example: 'someone@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class CompleteAliasRecoveryDto {
  @ApiProperty({ description: 'The token delivered by email.' })
  @IsString()
  @MaxLength(200)
  token!: string;

  @ApiProperty({
    description: 'The address that will own the alias from now on.',
  })
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'address must be a Stellar public key (G…)',
  })
  address!: string;

  @ApiProperty({ example: 'public' })
  @IsString()
  @MaxLength(40)
  network!: string;

  @ApiProperty({ description: 'The nonce from a RECOVER challenge.' })
  @IsString()
  @MaxLength(128)
  nonce!: string;

  @ApiProperty({ description: 'base64 ed25519 over the challenge digest.' })
  @IsString()
  @MaxLength(200)
  signature!: string;
}

export class QueryAliasesDto {
  @ApiPropertyOptional({ default: ALIAS_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ALIAS_PAGE_SIZE)
  take: number = ALIAS_PAGE_SIZE;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
