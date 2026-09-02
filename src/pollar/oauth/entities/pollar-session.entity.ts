import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A wallet Pollar resolved for the user. `internal` ones are Pollar-custodied. */
export class PollarWalletEntity {
  @ApiProperty({
    enum: ['internal', 'smart', 'external'],
    description:
      '`internal` is the virtual wallet Pollar custodies in its KMS — the one ' +
      'a social login gets. `smart` is a passkey C-address, `external` a wallet ' +
      'the user connected themselves.',
    example: 'internal',
  })
  type!: string;

  @ApiPropertyOptional({
    description:
      'Stellar public key (`G…`), or the C-address for a smart wallet.',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  address!: string | null;

  @ApiPropertyOptional({
    example: 'STELLAR',
    enum: ['STELLAR', 'POLYGON', 'SOLANA'],
  })
  chain?: string;

  @ApiPropertyOptional({
    description:
      'False when the account has no XLM reserve yet — the Deferred funding ' +
      'mode. Activate it with POST /v1/pollar/wallets/activate once your own ' +
      'business event says the user has earned an on-chain account.',
    example: true,
  })
  exists_on_stellar?: boolean;

  @ApiPropertyOptional({
    enum: ['IMMEDIATE', 'DEFERRED'],
    example: 'IMMEDIATE',
  })
  funding_mode?: string;

  @ApiPropertyOptional({ example: 'testnet' })
  network?: string;
}

/** The end-user profile Pollar assembled from the OAuth provider. */
export class PollarProfileEntity {
  @ApiPropertyOptional({ example: 'ada@example.com' })
  email?: string;

  @ApiPropertyOptional({ example: 'Ada' })
  first_name?: string;

  @ApiPropertyOptional({ example: 'Lovelace' })
  last_name?: string;

  @ApiPropertyOptional({ example: 'https://lh3.googleusercontent.com/a/…' })
  avatar?: string;
}

/**
 * The redemption result: a live Pollar session, handed straight through.
 *
 * The bridge does not keep a copy. From here the wallet talks to Pollar's SDK
 * API itself — `Authorization: Bearer <access_token>` plus the publishable key
 * in `x-pollar-api-key` — to read balances, build and submit transactions, and
 * everything else the virtual wallet can do.
 */
export class PollarSessionEntity {
  @ApiProperty({
    description: 'Pollar end-user access token (a JWT).',
  })
  access_token!: string;

  @ApiProperty({
    description:
      'Single-use refresh token. Pollar rotates it on every refresh and treats ' +
      'a replay as a compromise, revoking the family.',
  })
  refresh_token!: string;

  @ApiProperty({
    enum: ['Bearer', 'DPoP'],
    description:
      '`DPoP` when the handshake supplied a `dpop_jwk`: every call must then ' +
      "carry a proof signed by the wallet's private key, and this service can " +
      'no longer refresh or revoke on its behalf.',
    example: 'Bearer',
  })
  token_type!: string;

  @ApiProperty({
    description:
      'Access-token expiry, epoch milliseconds as Pollar reports it.',
    example: 1788350400000,
  })
  expires_at!: number;

  @ApiPropertyOptional({
    description: "Pollar's id for the end user.",
    example: 'usr_01J8Z3K2M4N5P6Q7R8S9T0',
  })
  user_id!: string | null;

  @ApiProperty({
    description:
      'The wallet the session acts as. Null address means Pollar has not ' +
      'provisioned one yet.',
    type: PollarWalletEntity,
  })
  wallet!: PollarWalletEntity;

  @ApiProperty({
    description: 'Every wallet linked to the user, including the one above.',
    type: [PollarWalletEntity],
  })
  wallets!: PollarWalletEntity[];

  @ApiProperty({ type: PollarProfileEntity })
  profile!: PollarProfileEntity;

  @ApiProperty({
    description:
      'The Pollar publishable key for this network. The wallet needs it in ' +
      '`x-pollar-api-key` on every direct call, and it is public by design.',
    example: 'pub_testnet_xxxxxxxxxxxxxxxxxxxx',
  })
  publishable_key!: string;

  @ApiProperty({
    description:
      'Base URL the access token is good against, version included. Call it ' +
      'directly; this service does not proxy the wallet surface.',
    example: 'https://sdk.api.pollar.xyz/v2',
  })
  api_base_url!: string;
}

/** A refreshed token pair. Same tokens, no profile — nothing else changed. */
export class PollarTokenPairEntity {
  @ApiProperty()
  access_token!: string;

  @ApiProperty()
  refresh_token!: string;

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  token_type!: string;

  @ApiProperty({ example: 1788350400000 })
  expires_at!: number;
}

/** Outcome of a revoke. */
export class PollarLogoutEntity {
  @ApiProperty({
    description: 'How many sessions Pollar revoked.',
    example: 1,
  })
  revoked!: number;
}
