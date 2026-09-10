import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AliasAddressEntity {
  @ApiProperty() id!: string;
  @ApiProperty() address!: string;
  @ApiProperty({ example: 'public' }) network!: string;
  @ApiPropertyOptional({ nullable: true }) label!: string | null;
  @ApiProperty({ description: 'The default for this network.' })
  isPrimary!: boolean;
  @ApiProperty({ description: 'When this address proved control of itself.' })
  verifiedAt!: Date;
}

export class AliasEntity {
  @ApiProperty() id!: string;
  @ApiProperty({
    description: 'Normalized handle — the form uniqueness is decided on.',
  })
  name!: string;
  @ApiProperty({ description: 'As the claimant typed it. Display only.' })
  displayName!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status!: string;
  @ApiProperty({ type: [AliasAddressEntity] }) addresses!: AliasAddressEntity[];
  @ApiProperty() createdAt!: Date;
}

/**
 * What the OWNER sees. Adds the recovery mailbox, which resolution must never
 * return — an alias is public by design and its owner's email is not.
 */
export class OwnedAliasEntity extends AliasEntity {
  @ApiProperty({ example: 'someone@example.com' }) email!: string;
  @ApiPropertyOptional({ nullable: true }) emailVerifiedAt!: Date | null;
}

export class AliasListEntity {
  @ApiProperty({ type: [OwnedAliasEntity] }) data!: OwnedAliasEntity[];
  @ApiProperty() total!: number;
  @ApiProperty() take!: number;
  @ApiProperty() skip!: number;
}

export class AliasChallengeEntity {
  @ApiProperty({ description: 'Send this back with the signature.' })
  nonce!: string;
  @ApiProperty({
    description:
      'The EXACT string to digest and sign. Returned rather than described so a ' +
      'client never rebuilds it from prose — a client that assembles the fields ' +
      'itself is one field-order change away from producing signatures nothing accepts.',
  })
  message!: string;
  @ApiProperty({ description: 'Domain tag the digest is framed with.' })
  domain!: string;
  @ApiProperty({ enum: ['CLAIM', 'ADD_ADDRESS', 'RECOVER'] }) purpose!: string;
  @ApiProperty() expiresAt!: Date;
}

/**
 * What a payer's wallet gets. No email, no consumer, no timestamps beyond the
 * proof date — everything here is safe to show to a stranger, because anyone who
 * knows the handle can ask.
 */
export class AliasResolutionEntity {
  @ApiProperty() name!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({
    type: [AliasAddressEntity],
    description:
      'Every verified address on the requested network, primary first.',
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
export class AliasRecoveryStartedEntity {
  @ApiProperty({
    description: 'Always true — see the note on enumeration in the service.',
  })
  accepted!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The token to email. Null when there was nothing to recover.',
  })
  token!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The mailbox to deliver to.',
  })
  email!: string | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: Date | null;
}

export class AliasAvailabilityEntity {
  @ApiProperty() name!: string;
  @ApiProperty() available!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Why not, when unavailable: taken, reserved, bad_characters, …',
  })
  reason!: string | null;
}

export class AliasDeletedEntity {
  @ApiProperty() id!: string;
  @ApiProperty() deleted!: boolean;
}
