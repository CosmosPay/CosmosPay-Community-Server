import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AUTH_METHOD_TYPES, IDENTITY_ROLES } from '@/recovery/recovery-core';

/** Shape only; `isAccountId` decodes and checksums where it matters. */
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** base64url, which is what every claim token here is encoded as. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class Sep10ChallengeQueryDto {
  @ApiProperty({ description: 'The Stellar account (G…) to authenticate.' })
  @Matches(STELLAR_ADDRESS, { message: 'account must be a G… address' })
  account!: string;
}

export class Sep10TokenDto {
  @ApiProperty({ description: 'The challenge, signed by the account.' })
  @IsString()
  @MaxLength(16_384)
  transaction!: string;
}

export class AuthMethodDto {
  @ApiProperty({ enum: AUTH_METHOD_TYPES })
  @IsIn(AUTH_METHOD_TYPES)
  type!: string;

  @ApiProperty({ example: 'person@example.com' })
  @IsEmail()
  @MaxLength(254)
  value!: string;
}

export class IdentityDto {
  @ApiProperty({ enum: IDENTITY_ROLES })
  @IsIn(IDENTITY_ROLES)
  role!: string;

  @ApiProperty({ type: [AuthMethodDto] })
  @ValidateNested({ each: true })
  @Type(() => AuthMethodDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  auth_methods!: AuthMethodDto[];
}

export class Sep30IdentitiesDto {
  @ApiProperty({ type: [IdentityDto] })
  @ValidateNested({ each: true })
  @Type(() => IdentityDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  identities!: IdentityDto[];
}

export class Sep30AddressParamDto {
  @Matches(STELLAR_ADDRESS, { message: 'address must be a G… address' })
  address!: string;
}

export class Sep30SignParamDto {
  @Matches(STELLAR_ADDRESS, { message: 'address must be a G… address' })
  address!: string;

  @Matches(STELLAR_ADDRESS, { message: 'signer must be a G… address' })
  signer!: string;
}

export class Sep30SignDto {
  @ApiProperty({ description: 'The transaction to co-sign, base64 XDR.' })
  @IsString()
  @MaxLength(16_384)
  transaction!: string;
}

export class Sep30ListQueryDto {
  @ApiPropertyOptional({
    description: 'The last address of the previous page.',
  })
  @IsOptional()
  @Matches(STELLAR_ADDRESS, { message: 'after must be a G… address' })
  after?: string;
}

export class RecoveryIdTokenDto {
  @ApiProperty({
    description:
      'An OIDC ID token from the provider this server names as OIDC_ISSUER in ' +
      'its stellar.toml. Accepted once per server.',
  })
  @IsString()
  @MaxLength(16_384)
  id_token!: string;
}

export class RecoveryEmailStartDto {
  @ApiProperty({ example: 'person@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class RecoveryEmailVerifyDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  @Matches(BASE64URL, { message: 'claim_token must be base64url' })
  claim_token!: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code!: string;
}
