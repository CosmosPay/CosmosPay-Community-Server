import { ApiProperty, ApiSchema } from '@nestjs/swagger';

/** Issuer powers a holder cannot undo once the trustline exists. */
@ApiSchema({
  description:
    'Issuer powers over an asset that a holder cannot undo once the trustline exists.',
})
export class AssetIssuerFlagsEntity {
  @ApiProperty({
    example: true,
    description: 'The issuer may freeze this trustline.',
  })
  authRevocable!: boolean;

  @ApiProperty({
    example: false,
    description: 'The issuer may claw the balance back out of the holder.',
  })
  clawback!: boolean;
}

/**
 * One catalogued asset.
 *
 * `code` + `issuer` together are the identity; neither alone is. Clients that key
 * anything on `code` will eventually key two different tokens to one entry — the
 * catalog deliberately carries two `EURC` rows from different issuers so that bug
 * shows up in development rather than in someone's balance.
 */
@ApiSchema({
  description:
    "One catalogued Stellar asset with its issuer's identity. `code` and `issuer` together identify it; neither alone does.",
})
export class AssetEntity {
  @ApiProperty({
    example: 'USDT0',
    description:
      'Stellar asset code (1 to 12 alphanumeric characters); `XLM` for the native asset.',
  })
  code!: string;

  @ApiProperty({
    nullable: true,
    example: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q',
    description: 'Issuing account, or null for native XLM.',
  })
  issuer!: string | null;

  @ApiProperty({
    example: 'USDT0',
    description: 'Display name of the asset (e.g. `USD Coin`).',
  })
  name!: string;

  @ApiProperty({
    example: 'Tether',
    description: 'Who issues it, for display next to the code.',
  })
  issuerName!: string;

  @ApiProperty({
    example: 'circle.com',
    description:
      "The issuer's on-chain home_domain, or empty when it publishes none, " +
      'which is the case for USDT0 and every testnet issuer. Never a domain ' +
      'attributed by a third party: rendered next to a token, that reads as the ' +
      "issuer's own claim.",
  })
  issuerDomain!: string;

  @ApiProperty({
    example: true,
    description:
      'Whether the issuing account was checked against the named organization. ' +
      'A claim about identity, not about quality: render unverified rows ' +
      'differently rather than hiding them.',
  })
  verified!: boolean;

  @ApiProperty({
    nullable: true,
    example: 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
    description: 'Stellar Asset Contract id, when wrapped for Soroban.',
  })
  contract!: string | null;

  @ApiProperty({
    type: AssetIssuerFlagsEntity,
    description: "Issuer powers over the holder's trustline.",
  })
  flags!: AssetIssuerFlagsEntity;
}

@ApiSchema({
  description:
    'The asset catalog of one Stellar network, with its registry version.',
})
export class AssetListEntity {
  @ApiProperty({
    example: 'public',
    enum: ['public', 'testnet'],
    description: 'The Stellar network listed: `public` (mainnet) or `testnet`.',
  })
  network!: string;

  @ApiProperty({
    example: 1,
    description:
      'Monotonic registry version. A client holding a bundled copy compares ' +
      'this against its own and keeps whichever is newer.',
  })
  version!: number;

  @ApiProperty({
    type: [AssetEntity],
    description: 'The catalogued assets of that network.',
  })
  data!: AssetEntity[];
}
