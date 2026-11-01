import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
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

@ApiSchema({
  description:
    'SEP-10: the signed challenge transaction, exchanged for a token of that account.',
})
export class Sep10TokenDto {
  @ApiProperty({ description: 'The challenge, signed by the account.' })
  @IsString()
  @MaxLength(16_384)
  transaction!: string;
}

@ApiSchema({
  description: 'SEP-30: one way to prove an identity (an email address).',
})
export class AuthMethodDto {
  @ApiProperty({
    enum: AUTH_METHOD_TYPES,
    description: 'The kind of auth method; `email` is the only one accepted.',
  })
  @IsIn(AUTH_METHOD_TYPES)
  type!: string;

  @ApiProperty({
    example: 'person@example.com',
    description: 'The email address that proves this identity.',
  })
  @IsEmail()
  @MaxLength(254)
  value!: string;
}

@ApiSchema({
  description:
    'SEP-30: one identity that may recover the account, with its role and auth methods.',
})
export class IdentityDto {
  @ApiProperty({
    enum: IDENTITY_ROLES,
    description: "The identity's role: `owner`, `sender` or `receiver`.",
  })
  @IsIn(IDENTITY_ROLES)
  role!: string;

  @ApiProperty({
    type: [AuthMethodDto],
    description: 'How this identity proves itself.',
  })
  @ValidateNested({ each: true })
  @Type(() => AuthMethodDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  auth_methods!: AuthMethodDto[];
}

@ApiSchema({
  description: 'SEP-30: the identities that may recover an account.',
})
export class Sep30IdentitiesDto {
  @ApiProperty({
    type: [IdentityDto],
    description: "The account's identities.",
  })
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

@ApiSchema({
  description:
    'SEP-30: a transaction for this server to co-sign for a recovered account.',
})
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

@ApiSchema({
  description: 'Proves an inbox to this recovery server with an OIDC ID token.',
})
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

@ApiSchema({
  description:
    'Asks this recovery server to email a code that proves an inbox.',
})
export class RecoveryEmailStartDto {
  @ApiProperty({
    example: 'person@example.com',
    description: 'The inbox to prove.',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

@ApiSchema({ description: 'Answers the code this recovery server emailed.' })
export class RecoveryEmailVerifyDto {
  @ApiProperty({
    description:
      'The `claim_token` from `POST /v1/sep30/identity/email/start` (base64url).',
  })
  @IsString()
  @MaxLength(128)
  @Matches(BASE64URL, { message: 'claim_token must be base64url' })
  claim_token!: string;

  @ApiProperty({ example: '123456', description: 'The six digits emailed.' })
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code!: string;
}

/** Standard base64 — how the wallet encodes a half of a backup's recovery key. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

@ApiSchema({
  description:
    "This server's half of a wallet backup's recovery key, filed under the inbox that may take it back.",
})
export class RecoveryShareDto {
  @ApiProperty({
    description:
      "This server's half of the backup's recovery key: 32 random-looking " +
      "bytes, base64. Useless without the other server's half.",
    example: 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=',
  })
  @IsString()
  @MaxLength(64)
  @Matches(BASE64, { message: 'share must be base64' })
  share!: string;

  @ApiProperty({
    description:
      'The inbox that may take the half back, proven to THIS server with its ' +
      'identity token.',
    example: 'person@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
