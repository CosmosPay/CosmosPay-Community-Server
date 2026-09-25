import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BACKUP_BOX_MAX_CHARS } from '@/wallet-auth/wallet-auth.constants';

/**
 * The providers a client may name. Lowercase, which is the wire spelling —
 * `providerFromWire` maps it to the enum and refuses everything else.
 */
export const WALLET_AUTH_PROVIDER_VALUES = ['google', 'github'];

/**
 * Stellar public keys are 56 base32 characters opening with `G`. Validated here
 * as SHAPE only; `@/common/stellar-key` decodes and checksums it. Two layers,
 * because the shape check gives a clean 400 naming the field and the decode
 * gives the guarantee.
 */
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/**
 * An ISO instant in UTC, to the millisecond at most.
 *
 * Pinned rather than left to `Date.parse`, which accepts strings carrying their
 * own offset — "the same instant written differently" is not something a replay
 * window should have to reason about. `signedAtFresh` enforces the same shape;
 * this one only makes the refusal a readable 400.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** base64url, which is what PKCE and every token here is encoded as. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class StartWalletOauthDto {
  @ApiProperty({ enum: WALLET_AUTH_PROVIDER_VALUES, example: 'google' })
  @IsIn(WALLET_AUTH_PROVIDER_VALUES)
  provider!: string;

  @ApiProperty({
    description:
      'base64url(SHA-256(verifier)) — RFC 7636 S256. Keep the verifier on the ' +
      'device: it is what makes a `state` seen in a browser worthless to ' +
      'anyone else, and it is the only thing that can redeem this handshake.',
    example: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  })
  @IsString()
  @MinLength(43)
  @MaxLength(128)
  @Matches(BASE64URL, { message: 'codeChallenge must be base64url' })
  codeChallenge!: string;
}

export class ClaimWalletOauthDto {
  @ApiProperty({ description: 'The handshake handle, from /oauth/authorize.' })
  @IsString()
  @MaxLength(128)
  state!: string;

  @ApiProperty({
    description:
      'The PKCE verifier this device kept. Never sent anywhere else, and never ' +
      'stored by this service.',
  })
  @IsString()
  @MinLength(43)
  @MaxLength(128)
  @Matches(BASE64URL, { message: 'verifier must be base64url' })
  verifier!: string;
}

export class StartWalletEmailDto {
  @ApiProperty({ example: 'someone@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class VerifyWalletEmailDto {
  @ApiProperty({
    description: 'The claim token returned by /auth/email/start.',
  })
  @IsString()
  @MaxLength(128)
  claimToken!: string;

  @ApiProperty({ example: '048213', description: 'The six digits emailed.' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code!: string;
}

/**
 * The session token is NOT in this body — it rides in `Authorization: Bearer`,
 * which is where the wallet already puts it and where a credential belongs.
 */
export class FinishWalletSignInDto {
  @ApiProperty({
    description:
      'The Stellar ACCOUNT this identity is attached to. Not necessarily the ' +
      'key that signs: a recovered account keeps its address and changes its ' +
      'signer.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'stellarAddress must be a Stellar public key (G…)',
  })
  stellarAddress!: string;

  @ApiProperty({ example: '2026-01-02T03:04:05Z' })
  @IsString()
  @Matches(ISO_INSTANT, { message: 'signedAt must be an ISO instant in UTC' })
  signedAt!: string;

  @ApiProperty({
    description:
      'base64 ed25519 signature over the sign-in challenge. The exact bytes are ' +
      'documented on the operation; a client that rebuilds them from prose is ' +
      'one field-order change away from producing signatures nothing accepts.',
  })
  @IsString()
  @MaxLength(128)
  signature!: string;

  @ApiPropertyOptional({
    description:
      "The device's sealed seed box, to keep for the next device. Opaque here: " +
      'it is sealed under a key derived from a password this service never sees.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(BACKUP_BOX_MAX_CHARS)
  backup?: string;

  @ApiPropertyOptional({
    description:
      'Replace the backup this account already has, discarding it. The "forgot ' +
      'the password" door: the box being discarded may be the only copy of a ' +
      'funded wallet, so it is never implied — a client sends it only after the ' +
      'person has acknowledged what it gives up.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  replaceBackup?: boolean;
}

export class ReplaceWalletBackupDto {
  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'stellarAddress must be a Stellar public key (G…)',
  })
  stellarAddress!: string;

  @ApiProperty({ description: 'The re-sealed box. Opaque to this service.' })
  @IsString()
  @MaxLength(BACKUP_BOX_MAX_CHARS)
  box!: string;

  @ApiProperty({ example: '2026-01-02T03:04:05Z' })
  @IsString()
  @Matches(ISO_INSTANT, { message: 'signedAt must be an ISO instant in UTC' })
  signedAt!: string;

  @ApiProperty({
    description:
      'base64 ed25519 signature over the backup challenge, which covers the ' +
      "box's SHA-256 — so one signature stores exactly one box.",
  })
  @IsString()
  @MaxLength(128)
  signature!: string;
}
