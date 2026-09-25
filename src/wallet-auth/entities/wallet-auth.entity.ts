import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/*
 * These shapes are a CONTRACT with the wallet, which asserts them field by field
 * in its own `src/lib/signInShapes.ts`. They are documented here exactly as the
 * service returns them — a published shape that flatters the implementation is
 * worse than none, because an integrator builds against it.
 *
 * Several responses are discriminated on `status`, and every branch is listed
 * rather than collapsed into optionals: "which fields are present" is the whole
 * information in them.
 */

export class WalletAuthProvidersEntity {
  @ApiProperty({
    type: [String],
    example: ['authentik', 'google', 'github'],
    description:
      'Which providers this deployment has credentials for. Render buttons ' +
      'from this rather than from a compiled-in list, so a deployment that ' +
      'configured neither does not show two buttons that die at the consent ' +
      'screen.',
  })
  providers!: string[];

  @ApiProperty({
    description:
      'Whether the email-code door works here. False when no console is ' +
      'configured to deliver the mail.',
  })
  email!: boolean;
}

export class WalletOauthStartedEntity {
  @ApiProperty({
    description:
      'The handshake handle. Public by construction — it travels in a URL bar. ' +
      'Knowing it buys polling, never redemption.',
  })
  state!: string;

  @ApiProperty({ description: 'Open this in a browser.' })
  authorizationUrl!: string;

  @ApiProperty() expiresAt!: Date;
}

export class WalletAuthStatusEntity {
  @ApiProperty({
    enum: ['pending', 'authorized', 'redeemed', 'failed', 'expired'],
    description:
      'Poll until this leaves `pending`. `authorized` means the person came ' +
      'back and the identity is waiting for the PKCE verifier. The identity ' +
      'itself is never in this response, at any status.',
  })
  status!: string;

  @ApiPropertyOptional({
    enum: ['denied', 'email_unverified', 'profile_invalid', 'failed'],
    description:
      'Present only on `failed`. A token to map to a sentence — never prose, ' +
      'which cannot be translated on the device.',
  })
  error?: string;
}

class WalletAuthIdentityEntity {
  @ApiProperty({ example: 'someone@example.com' }) email!: string;
  @ApiPropertyOptional({ nullable: true }) name!: string | null;
  @ApiPropertyOptional({ nullable: true }) avatar!: string | null;
  @ApiProperty({
    enum: ['authentik', 'google', 'github', 'email'],
    description: 'How the email was proven.',
  })
  method!: string;
}

class WalletBackupEntity {
  @ApiProperty({ description: 'The account this box restores to.' })
  stellarAddress!: string;

  @ApiProperty({
    description:
      'The sealed box, verbatim. Opaque to this service: only the password ' +
      'opens it, and the password never arrives here.',
  })
  box!: string;

  @ApiProperty() updatedAt!: string;
}

/**
 * `status: 'ready'` — what a proven email is worth.
 *
 * Returned by `/oauth/claim` for a NEW email and by `/email/verify` for any.
 */
export class WalletAuthReadyEntity {
  @ApiProperty({ enum: ['ready'] }) status!: string;

  @ApiProperty({ type: WalletAuthIdentityEntity })
  identity!: WalletAuthIdentityEntity;

  @ApiProperty({
    enum: ['existing', 'new'],
    description:
      'Whether this email already had an account here. A marker, never an id: ' +
      'it is what a client branches its onboarding on.',
  })
  account!: string;

  @ApiPropertyOptional({
    type: WalletBackupEntity,
    nullable: true,
    description: 'The box this account last stored, if any.',
  })
  backup!: WalletBackupEntity | null;

  @ApiProperty({
    description:
      'Short-lived, sealed, and accepted by exactly one route: `/auth/finish`. ' +
      'It is the only credential that can create an account or put a backup ' +
      'under one, so it is never refreshed — a person who takes longer signs ' +
      'in again.',
  })
  sessionToken!: string;

  @ApiProperty({ example: 1800 }) expiresInSeconds!: number;

  @ApiPropertyOptional({
    description:
      "The OIDC provider's ID token, present ONLY when the sign-in went through " +
      'Authentik AND the inbox was proven with an emailed code after it (a claim ' +
      "with `purpose: 'recovery'`, or an existing account). It is what the SEP-30 " +
      "recovery servers accept as the person's identity, each verifying it " +
      "against the provider's keys. Never stored by the wallet.",
  })
  idToken?: string;
}

/**
 * `status: 'verify_email'` — the fork that protects an existing account.
 *
 * A provider proves who consented, not who opened the sign-in. An account that
 * already exists is where the backup worth stealing is, so it gets a code in its
 * own inbox instead of a token.
 */
export class WalletAuthVerifyEmailEntity {
  @ApiProperty({ enum: ['verify_email'] }) status!: string;
  @ApiProperty({ description: 'Send this back with the code.' })
  claimToken!: string;
  @ApiProperty({ example: 900 }) expiresInSeconds!: number;
  @ApiProperty({ description: 'The mailbox the code went to.' })
  email!: string;
}

export class WalletEmailStartedEntity {
  @ApiProperty({
    description:
      'Identifies WHICH code is being answered, so a second request for the ' +
      'same mailbox cannot be answered with the first code. Only its SHA-256 ' +
      'is stored here.',
  })
  claimToken!: string;

  @ApiProperty({ example: 900 }) expiresInSeconds!: number;
}

/** `status: 'invalid'` — a wrong code, with what is left before the row burns. */
export class WalletCodeInvalidEntity {
  @ApiProperty({ enum: ['invalid'] }) status!: string;
  @ApiProperty({ example: 4 }) attemptsLeft!: number;
}

class WalletProvisionedKeysEntity {
  @ApiPropertyOptional({ nullable: true }) dev!: string | null;
  @ApiPropertyOptional({ nullable: true }) prod!: string | null;
}

/** `status: 'ready'` — the account exists and holds its gateway credentials. */
export class WalletSignInFinishedEntity {
  @ApiProperty({ enum: ['ready'] }) status!: string;
  @ApiProperty({
    enum: ['created', 'linked'],
    description:
      'Whether this call created the account or attached the identity to one ' +
      'that already existed. A different vocabulary from `ready.account`, ' +
      'deliberately — they answer two different questions.',
  })
  account!: string;
  @ApiProperty() organizationId!: string;
  @ApiProperty({ type: WalletProvisionedKeysEntity })
  keys!: WalletProvisionedKeysEntity;
}

/**
 * `status: 'backup_conflict'` — this account already holds a box for a
 * DIFFERENT address, and nothing authorized discarding it.
 *
 * Not an error: it is the state a client turns into "you already have a wallet
 * backed up here". Retry with `replaceBackup: true` only after the person has
 * acknowledged what that gives up — the box may be the only copy of a funded
 * wallet.
 */
export class WalletBackupConflictEntity {
  @ApiProperty({ enum: ['backup_conflict'] }) status!: string;
  @ApiProperty({ description: 'The address the stored box restores to.' })
  stellarAddress!: string;
}

export class WalletBackupUpdatedEntity {
  @ApiProperty({ enum: ['ok'] }) status!: string;
  @ApiProperty() stellarAddress!: string;
  @ApiProperty() updatedAt!: Date;
}

/** `POST /v1/wallet/recovery/setup` — the sponsored setup, for the account to sign. */
export class WalletRecoverySetupEntity {
  @ApiProperty({
    description:
      'base64 XDR, signed by the sponsor and NOT by the account: the wallet adds ' +
      'its signature only after its own guard has decoded every operation.',
  })
  transaction!: string;

  @ApiProperty({ description: 'The account paying the two signer reserves.' })
  sponsor!: string;

  @ApiProperty() network_passphrase!: string;
}
