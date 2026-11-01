import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { CHAINS } from '@/chains/chains.constants';

@ApiSchema({
  description:
    'One verified address an alias resolves to, on one chain and network.',
})
export class AliasAddressEntity {
  @ApiProperty({
    description:
      'The id of this address on the alias, as `DELETE /v1/aliases/{name}/addresses/{addressId}` takes it.',
  })
  id!: string;
  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'The chain the address is on.',
  })
  chain!: string;
  @ApiProperty({
    description: 'On `chain`: Stellar G…, Solana base58, Monad 0x… (EIP-55).',
  })
  address!: string;
  @ApiProperty({
    example: 'public',
    description:
      'Network id the address is on: public | testnet | a custom id.',
  })
  network!: string;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Human label the owner gave this address; null without one.',
  })
  label!: string | null;
  @ApiProperty({ description: 'The default for this chain and network.' })
  isPrimary!: boolean;
  @ApiProperty({ description: 'When this address proved control of itself.' })
  verifiedAt!: Date;
}

export class AliasEntity {
  @ApiProperty({ description: 'The alias id.' }) id!: string;
  @ApiProperty({
    description: 'Normalized handle: the form uniqueness is decided on.',
  })
  name!: string;
  @ApiProperty({ description: 'As the claimant typed it. Display only.' })
  displayName!: string;
  @ApiProperty({
    enum: ['ACTIVE', 'SUSPENDED'],
    description:
      'SUSPENDED when an operator holds the alias (an impersonation report, a ' +
      'dispute): a suspended alias does not resolve.',
  })
  status!: string;
  @ApiProperty({
    type: [AliasAddressEntity],
    description:
      'Every address of the alias, on every chain and network, primary first.',
  })
  addresses!: AliasAddressEntity[];
  @ApiProperty({
    description: 'When the alias was claimed (ISO 8601 date-time).',
  })
  createdAt!: Date;
}

/**
 * What the OWNER sees. Adds the recovery mailbox, which resolution must never
 * return — an alias is public by design and its owner's email is not.
 */
@ApiSchema({
  description:
    'An alias as its owner sees it: the public fields plus the recovery ' +
    'mailbox, which resolution never returns.',
})
export class OwnedAliasEntity extends AliasEntity {
  @ApiProperty({
    example: 'someone@example.com',
    description: 'The recovery mailbox, trimmed and lowercased.',
  })
  email!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'When the recovery mailbox was verified (ISO 8601 date-time); null while it is not.',
  })
  emailVerifiedAt!: Date | null;
}

@ApiSchema({
  description: "One page of the caller's aliases, newest first.",
})
export class AliasListEntity {
  @ApiProperty({
    type: [OwnedAliasEntity],
    description: 'The aliases on this page, newest first.',
  })
  data!: OwnedAliasEntity[];
  @ApiProperty({
    description: 'How many aliases the caller holds, across all pages.',
  })
  total!: number;
  @ApiProperty({ description: 'The page size this page was read with.' })
  take!: number;
  @ApiProperty({
    description: 'How many aliases were skipped before this page.',
  })
  skip!: number;
}

@ApiSchema({
  description:
    'A single-use challenge to sign: send `nonce` back with the signature over ' +
    '`message` before `expiresAt`.',
})
export class AliasChallengeEntity {
  @ApiProperty({ description: 'Send this back with the signature.' })
  nonce!: string;
  @ApiProperty({
    description:
      'The EXACT string to sign: digested first on Stellar, signed as text on ' +
      'Solana and Monad. Returned rather than described so a client never ' +
      'rebuilds it from prose. A client that assembles the fields itself is ' +
      'one field-order change away from producing signatures nothing accepts.',
  })
  message!: string;
  @ApiProperty({ description: 'Domain tag the digest is framed with.' })
  domain!: string;
  @ApiProperty({
    enum: ['CLAIM', 'ADD_ADDRESS', 'RECOVER'],
    description:
      'What the signature can be spent on: the purpose the request asked for.',
  })
  purpose!: string;
  @ApiProperty({
    description:
      'When the challenge stops being spendable (ISO 8601 date-time), 5 minutes after it was issued.',
  })
  expiresAt!: Date;
}

/**
 * What a payer's wallet gets. No email, no consumer, no timestamps beyond the
 * proof date — everything here is safe to show to a stranger, because anyone who
 * knows the handle can ask.
 */
@ApiSchema({
  description:
    'An alias resolved for a payer: its addresses on one chain, primary first, and nothing about its owner.',
})
export class AliasResolutionEntity {
  @ApiProperty({
    description: 'Normalized handle: the form uniqueness is decided on.',
  })
  name!: string;
  @ApiProperty({ description: 'As the claimant typed it. Display only.' })
  displayName!: string;
  @ApiProperty({
    enum: CHAINS,
    description: 'The chain resolved on: the one asked for, else Stellar.',
  })
  chain!: string;
  @ApiProperty({
    type: [AliasAddressEntity],
    description:
      'Every verified address on the requested chain and network, primary first.',
  })
  addresses!: AliasAddressEntity[];
  @ApiPropertyOptional({
    nullable: true,
    description: 'The address to pay when the payer did not choose one.',
  })
  primaryAddress!: string | null;
}

/**
 * The result of starting a recovery.
 *
 * The token is returned to the CALLER, which then delivers it by email — this
 * service sends no mail, exactly as the KYC terms-of-service flow does not. It is
 * the only time the plaintext exists outside the request: what is stored is a
 * SHA-256 of it.
 */
@ApiSchema({
  description:
    'The answer to starting a recovery: the same whether or not the alias and ' +
    'the mailbox matched.',
})
export class AliasRecoveryStartedEntity {
  @ApiProperty({
    example: true,
    description:
      'Always true, whether or not anything matched. The token, when there is ' +
      'one, is emailed to the mailbox on record, never returned here.',
  })
  accepted!: boolean;
}

@ApiSchema({
  description:
    'Whether a handle can be claimed now, and why not when it cannot. It reserves nothing.',
})
export class AliasAvailabilityEntity {
  @ApiProperty({
    description: 'The handle as checked: trimmed and lowercased.',
  })
  name!: string;
  @ApiProperty({ description: 'Whether the handle can be claimed now.' })
  available!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Why not, when unavailable: taken, reserved, bad_characters, …',
  })
  reason!: string | null;
}

@ApiSchema({
  description:
    'The answer to a delete: the id of the alias or address deleted.',
})
export class AliasDeletedEntity {
  @ApiProperty({
    description:
      'The id of what was deleted: the alias on a release, the address on an address removal.',
  })
  id!: string;
  @ApiProperty({ description: 'Always true.' })
  deleted!: boolean;
}

/** One active alias that names an address — never who owns it. */
@ApiSchema({
  description: 'One active alias that holds an address, never who owns it.',
})
export class AliasByAddressEntryEntity {
  @ApiProperty({
    example: 'alice',
    description: 'Normalized handle: the form uniqueness is decided on.',
  })
  name!: string;
  @ApiProperty({
    example: 'Alice',
    description: 'As the claimant typed it. Display only.',
  })
  displayName!: string;
  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'The chain the address is on.',
  })
  chain!: string;
  @ApiProperty({
    example: 'public',
    description:
      'Network id the address is on: public | testnet | a custom id.',
  })
  network!: string;
  @ApiProperty({ description: 'The default for this network.' })
  isPrimary!: boolean;
}

/** Empty, never 404: "no alias points here" is an answer, not a missing resource. */
@ApiSchema({
  description:
    'The active aliases that hold an address, oldest first. Empty, never a 404, when none does.',
})
export class AliasByAddressEntity {
  @ApiProperty({
    type: [AliasByAddressEntryEntity],
    description:
      'The active aliases holding the address, oldest first; empty when none does.',
  })
  data!: AliasByAddressEntryEntity[];
}
