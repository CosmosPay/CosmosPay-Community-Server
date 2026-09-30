import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { IsChainAddress } from '@/common/validators/is-chain-address.validator';
import {
  BACKUP_BOX_MAX_CHARS,
  RETURN_URL_MAX_CHARS,
  WALLET_SIGNATURE_MAX_CHARS,
} from '@/wallet-auth/wallet-auth.constants';

/**
 * The providers a client may name. Lowercase, which is the wire spelling —
 * `providerFromWire` maps it to the enum and refuses everything else.
 */
export const WALLET_AUTH_PROVIDER_VALUES = ['authentik', 'google', 'github'];

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

  @ApiProperty({
    enum: ['S256'],
    description:
      'RFC 7636 S256, the only method accepted. Declared rather than ignored: ' +
      'the wallet sends it, and an undeclared field is a 400 under ' +
      '`forbidNonWhitelisted`. Pinned rather than defaulted, because `plain` is ' +
      'the one value that would make the verifier no secret at all.',
  })
  @IsIn(['S256'])
  codeChallengeMethod!: string;

  @ApiPropertyOptional({
    description:
      'A native wallet’s own URL — a custom scheme, a universal/app link, or ' +
      '`http://127.0.0.1:<port>/…` from a desktop app. When set, the callback ' +
      'answers `302` to it with `?state=…` (plus `&error=<reason>` on failure) ' +
      'instead of rendering a page, which is what closes the platform’s auth ' +
      'session. Must be listed in the deployment’s `WALLET_AUTH_RETURN_URLS` ' +
      '(a loopback entry matches any port). Only the `state` travels: the ' +
      'handshake is still redeemed with the verifier.',
    example: 'cosmoswallet://auth/done',
  })
  @IsOptional()
  @IsString()
  @MaxLength(RETURN_URL_MAX_CHARS)
  returnTo?: string;
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
  @Matches(BASE64URL, { message: 'codeVerifier must be base64url' })
  codeVerifier!: string;

  @ApiPropertyOptional({
    enum: ['sign-in', 'recovery'],
    default: 'sign-in',
    description:
      '`recovery` when the proven identity is going to be presented to the ' +
      'SEP-30 recovery servers. It always routes through an emailed code, even ' +
      'for an email with no account, and only then does the answer carry the ' +
      "provider's `idToken` — a provider proves who consented, not who opened the " +
      'sign-in, and a recovery identity is worth a wallet.',
  })
  @IsOptional()
  @IsIn(['sign-in', 'recovery'])
  purpose?: 'sign-in' | 'recovery';
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
 * The session token is NOT in this body — it rides in `X-Wallet-Session`, a
 * header of its own because APISIX strips `Authorization` on the way here.
 */
export class FinishWalletSignInDto {
  // The ACCOUNT this identity is attached to. Not necessarily the key that
  // signs: a recovered Stellar account keeps its address and changes its signer.
  @ApiPropertyOptional({
    enum: CHAINS,
    default: 'stellar',
    description:
      'Chain the account is on. Omit for Stellar. Solana signs the challenge ' +
      'with ed25519 over its UTF-8 bytes; Monad with EIP-191 `personal_sign`.',
  })
  @IsOptional()
  @IsIn(CHAINS)
  chain?: Chain;

  @ApiPropertyOptional({
    description:
      'The account on `chain`: Stellar G…, Solana base58, Monad 0x…. Send this ' +
      'or `stellarAddress`, not both.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @ValidateIf(
    (o: { stellarAddress?: string }) => o.stellarAddress === undefined,
  )
  @IsChainAddress('chain')
  address?: string;

  @ApiPropertyOptional({
    description:
      'The Stellar account — the field’s original name, still accepted for ' +
      'Stellar. New clients send `address`.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    deprecated: true,
  })
  @ValidateIf((o: { address?: string }) => o.address === undefined)
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'stellarAddress must be a Stellar public key (G…)',
  })
  stellarAddress?: string;

  @ApiProperty({ example: '2026-01-02T03:04:05Z' })
  @IsString()
  @Matches(ISO_INSTANT, { message: 'signedAt must be an ISO instant in UTC' })
  signedAt!: string;

  @ApiProperty({
    description:
      'Signature over the sign-in challenge: base64 ed25519 on Stellar, base64 ' +
      'or base58 ed25519 on Solana, 0x-hex EIP-191 on Monad. The exact bytes ' +
      'are documented on the operation; a client that rebuilds them from prose ' +
      'is one field-order change away from producing signatures nothing accepts.',
  })
  @IsString()
  @MaxLength(WALLET_SIGNATURE_MAX_CHARS)
  signature!: string;

  @ApiPropertyOptional({
    description:
      "The device's sealed seed box, to keep for the next device — one per " +
      '(chain, address), up to 20 per account. Opaque here: it is sealed under a ' +
      'key derived from a password this service never sees.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(BACKUP_BOX_MAX_CHARS)
  backup?: string;

  @ApiPropertyOptional({
    description:
      'Accepted for older wallets and ignored. Backups are kept per wallet: a box ' +
      'for another address is added beside the ones the account keeps, and a box ' +
      'for the same wallet replaces its own — nothing is ever discarded to make room.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  replaceBackup?: boolean;
}

export class ReplaceWalletBackupDto {
  @ApiPropertyOptional({
    enum: CHAINS,
    default: 'stellar',
    description:
      'Chain the account is on. Omit for Stellar. Solana signs the challenge ' +
      'with ed25519 over its UTF-8 bytes; Monad with EIP-191 `personal_sign`.',
  })
  @IsOptional()
  @IsIn(CHAINS)
  chain?: Chain;

  @ApiPropertyOptional({
    description:
      'The account on `chain`: Stellar G…, Solana base58, Monad 0x…. Send this ' +
      'or `stellarAddress`, not both.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @ValidateIf(
    (o: { stellarAddress?: string }) => o.stellarAddress === undefined,
  )
  @IsChainAddress('chain')
  address?: string;

  @ApiPropertyOptional({
    description:
      'The Stellar account — the field’s original name, still accepted for ' +
      'Stellar. New clients send `address`.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    deprecated: true,
  })
  @ValidateIf((o: { address?: string }) => o.address === undefined)
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'stellarAddress must be a Stellar public key (G…)',
  })
  stellarAddress?: string;

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
      'Signature over the backup challenge (encoded as for sign-in), which ' +
      "covers the box's SHA-256 — so one signature stores exactly one box.",
  })
  @IsString()
  @MaxLength(WALLET_SIGNATURE_MAX_CHARS)
  signature!: string;
}

/**
 * `POST /v1/wallet/recovery/setup` — the operator pays the reserve of an
 * account's two recovery signers. The session token rides in `Authorization`.
 */
export class SponsorRecoverySetupDto {
  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsString()
  @Matches(STELLAR_ADDRESS, {
    message: 'stellarAddress must be a Stellar public key (G…)',
  })
  stellarAddress!: string;

  @ApiProperty({
    type: [String],
    description:
      "The two recovery servers' signers for this account, in role order.",
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @Matches(STELLAR_ADDRESS, {
    each: true,
    message: 'each signer must be a G… address',
  })
  signers!: string[];

  @ApiProperty({ example: '2026-01-02T03:04:05Z' })
  @IsString()
  @Matches(ISO_INSTANT, { message: 'signedAt must be an ISO instant in UTC' })
  signedAt!: string;

  @ApiProperty({
    description: 'base64 ed25519 signature over the recovery-setup challenge.',
  })
  @IsString()
  @MaxLength(128)
  signature!: string;
}
