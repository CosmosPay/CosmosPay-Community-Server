import { CHAINS } from '@/chains/chains.constants';
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

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

@ApiSchema({
  description:
    'An Authentik source (e.g. Google, GitHub) a wallet can show as a sign-in button of its own.',
})
export class WalletAuthSourceEntity {
  @ApiProperty({
    example: 'google',
    description: 'Send as `source` on /oauth/authorize.',
  })
  id!: string;

  @ApiProperty({
    example: 'Google',
    description: 'The button’s label: the provider’s own name.',
  })
  name!: string;
}

@ApiSchema({
  description: 'The sign-in methods this deployment offers to the wallet.',
})
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
    type: [WalletAuthSourceEntity],
    description:
      'Authentik’s own sources (Google, GitHub…), each to show as a button of ' +
      'its own that starts the Authentik sign-in at that source. With these, ' +
      'a wallet need not show a generic Authentik button. Empty without ' +
      'Authentik, or when the operator listed none (WALLET_AUTH_OIDC_SOURCES).',
  })
  sources!: WalletAuthSourceEntity[];

  @ApiProperty({
    description:
      'Whether the email-code door works here. False when no console is ' +
      'configured to deliver the mail.',
  })
  email!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'https://auth.example.com/if/user/#/settings;{"page":"page-credentials"}',
    description:
      'The page of the person’s Cosmos Pay (Authentik) account where they add ' +
      'or remove a second factor (a security key or passkey, an ' +
      'authenticator app, recovery codes), to open in a browser. It goes ' +
      'through the Authentik login first when there is no session. A second ' +
      'factor is optional (the sign-in only offers one), so offer this as a ' +
      'setting. Null when this deployment has no Authentik.',
  })
  mfaSettingsUrl!: string | null;
}

@ApiSchema({
  description:
    'A started OAuth sign-in handshake: the URL to open in a browser and the `state` handle to poll.',
})
export class WalletOauthStartedEntity {
  @ApiProperty({
    description:
      'The handshake handle. Public by construction: it travels in a URL bar. ' +
      'Knowing it buys polling, never redemption.',
  })
  state!: string;

  @ApiProperty({ description: 'Open this in a browser.' })
  authorizationUrl!: string;

  @ApiProperty({ description: 'When the handshake expires (ISO 8601).' })
  expiresAt!: Date;
}

@ApiSchema({
  description:
    'The state of an OAuth sign-in handshake. The identity itself is never in this response.',
})
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
      'Present only on `failed`. A token to map to a sentence, never prose, ' +
      'which cannot be translated on the device.',
  })
  error?: string;

  @ApiPropertyOptional({
    description:
      'Present (true) only on `authorized`, after an Authentik emailed sign-in ' +
      'whose callback sent the wallet’s return URL a device binding: claim with ' +
      'it (`binding`), or the claim sends the inbox a code. The value itself is ' +
      'never in this response.',
  })
  bound?: boolean;
}

@ApiSchema({
  description:
    'The identity a wallet sign-in proved: the email address and how it was proven.',
})
class WalletAuthIdentityEntity {
  @ApiProperty({
    example: 'someone@example.com',
    description: 'The proven email address.',
  })
  email!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Display name from the identity provider; null when it gave none.',
  })
  name!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Avatar image URL from the identity provider; null when it gave none.',
  })
  avatar!: string | null;
  @ApiProperty({
    enum: ['authentik', 'google', 'github', 'email'],
    description: 'How the email was proven.',
  })
  method!: string;
}

@ApiSchema({
  description:
    'One sealed wallet backup an account keeps: one box per chain and address.',
})
class WalletBackupEntity {
  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'The chain of the backed-up account.',
  })
  chain!: string;
  @ApiProperty({
    description:
      'The account this box restores to, on `chain` (Stellar G…, Solana base58, Monad 0x…).',
  })
  address!: string;
  @ApiProperty({
    description:
      'Same as `address` (the field’s original name, kept for older wallets).',
    deprecated: true,
  })
  stellarAddress!: string;

  @ApiProperty({
    description:
      "The sealed box, verbatim. Opaque to this service: only the person's " +
      'password or passkey opens it (a `v: 3` box carries one door per ' +
      'secret), and neither ever arrives here.',
  })
  box!: string;

  @ApiProperty({ description: 'When the box was last written (ISO 8601).' })
  updatedAt!: string;
}

/**
 * `status: 'ready'` — what a proven email is worth.
 *
 * Returned by `/oauth/claim` for a NEW email and by `/email/verify` for any.
 */
@ApiSchema({
  description:
    'A proven email: its identity, the backups its account keeps and the session token that finishes the sign-in.',
})
export class WalletAuthReadyEntity {
  @ApiProperty({ enum: ['ready'], description: 'Always `ready`.' })
  status!: string;

  @ApiProperty({
    type: WalletAuthIdentityEntity,
    description: 'The identity the sign-in proved.',
  })
  identity!: WalletAuthIdentityEntity;

  @ApiProperty({
    enum: ['existing', 'new'],
    description:
      'Whether this email already had an account here. A marker, never an id: ' +
      'it is what a client branches its onboarding on.',
  })
  account!: string;

  @ApiProperty({
    type: [WalletBackupEntity],
    description:
      'Every wallet this account keeps a backup of, newest first: one box per ' +
      '(chain, address). A new device opens each with the password (or passkey) ' +
      'it was sealed under; a box sealed under another password stays closed.',
  })
  backups!: WalletBackupEntity[];

  @ApiPropertyOptional({
    type: WalletBackupEntity,
    nullable: true,
    description: 'The newest of `backups`, for wallets that read a single box.',
    deprecated: true,
  })
  backup!: WalletBackupEntity | null;

  @ApiProperty({
    description:
      'Short-lived, sealed, and accepted by exactly one route: `/auth/finish`. ' +
      'It is the only credential that can create an account or put a backup ' +
      'under one, so it is never refreshed: a person who takes longer signs ' +
      'in again.',
  })
  sessionToken!: string;

  @ApiProperty({
    example: 1800,
    description: 'Lifetime of `sessionToken`, in seconds.',
  })
  expiresInSeconds!: number;

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
@ApiSchema({
  description:
    'The email already has an account: a code was sent to its inbox, to be answered with `claimToken`.',
})
export class WalletAuthVerifyEmailEntity {
  @ApiProperty({
    enum: ['verify_email'],
    description: 'Always `verify_email`.',
  })
  status!: string;
  @ApiProperty({ description: 'Send this back with the code.' })
  claimToken!: string;
  @ApiProperty({
    example: 900,
    description: 'Lifetime of the emailed code, in seconds.',
  })
  expiresInSeconds!: number;
  @ApiProperty({ description: 'The mailbox the code went to.' })
  email!: string;
}

@ApiSchema({
  description:
    'An emailed sign-in code was sent; answer it with this `claimToken`.',
})
export class WalletEmailStartedEntity {
  @ApiProperty({
    description:
      'Identifies WHICH code is being answered, so a second request for the ' +
      'same mailbox cannot be answered with the first code. Only its SHA-256 ' +
      'is stored here.',
  })
  claimToken!: string;

  @ApiProperty({
    example: 900,
    description: 'Lifetime of the emailed code, in seconds.',
  })
  expiresInSeconds!: number;
}

/** `status: 'invalid'` — a wrong code, with what is left before the row burns. */
@ApiSchema({
  description:
    'A wrong code, with how many attempts are left before the code stops being accepted.',
})
export class WalletCodeInvalidEntity {
  @ApiProperty({ enum: ['invalid'], description: 'Always `invalid`.' })
  status!: string;
  @ApiProperty({ example: 4, description: 'Attempts left for this code.' })
  attemptsLeft!: number;
}

@ApiSchema({
  description:
    'The gateway API keys of the signed-in account, one per environment.',
})
class WalletProvisionedKeysEntity {
  @ApiPropertyOptional({
    nullable: true,
    description: "The account's `dev` (testnet) API key.",
  })
  dev!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: "The account's `prod` (mainnet) API key.",
  })
  prod!: string | null;
}

/** `status: 'ready'` — the account exists and holds its gateway credentials. */
@ApiSchema({
  description:
    'A finished wallet sign-in: the account exists and holds its gateway API keys.',
})
export class WalletSignInFinishedEntity {
  @ApiProperty({ enum: ['ready'], description: 'Always `ready`.' })
  status!: string;
  @ApiProperty({
    enum: ['created', 'linked'],
    description:
      'Whether this call created the account or attached the identity to one ' +
      'that already existed. A different vocabulary from `ready.account`, ' +
      'deliberately: they answer two different questions.',
  })
  account!: string;
  @ApiProperty({
    description: "Id of the account's organization, carried by its API keys.",
  })
  organizationId!: string;
  @ApiProperty({
    type: WalletProvisionedKeysEntity,
    description: "The account's gateway API keys.",
  })
  keys!: WalletProvisionedKeysEntity;
}

@ApiSchema({
  description: 'Confirmation that a wallet backup box was replaced.',
})
export class WalletBackupUpdatedEntity {
  @ApiProperty({ enum: ['ok'], description: 'Always `ok`.' }) status!: string;
  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'The chain of the account whose box was replaced.',
  })
  chain!: string;
  @ApiProperty({
    description:
      'The account whose box was replaced, on `chain` (Stellar G…, Solana base58, Monad 0x…).',
  })
  address!: string;
  @ApiProperty({
    description:
      'Same as `address` (the field’s original name, kept for older wallets).',
    deprecated: true,
  })
  stellarAddress!: string;
  @ApiProperty({ description: 'When the box was replaced (ISO 8601).' })
  updatedAt!: Date;
}

/** `POST /v1/wallet/recovery/setup` — the sponsored setup, for the account to sign. */
@ApiSchema({
  description:
    'The sponsored recovery setup transaction, signed by the sponsor, for the account to sign.',
})
export class WalletRecoverySetupEntity {
  @ApiProperty({
    description:
      'base64 XDR, signed by the sponsor and NOT by the account: the wallet adds ' +
      'its signature only after its own guard has decoded every operation.',
  })
  transaction!: string;

  @ApiProperty({ description: 'The account paying the two signer reserves.' })
  sponsor!: string;

  @ApiProperty({
    description: 'Passphrase of the Stellar network the transaction is for.',
  })
  network_passphrase!: string;
}
