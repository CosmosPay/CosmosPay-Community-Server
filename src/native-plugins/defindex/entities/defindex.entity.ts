import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/**
 * What a DeFindex build answers: DeFindex's own response, passed through. Only
 * `xdr` matters to a caller; the rest is DeFindex's simulation, for display.
 */
@ApiSchema({
  description:
    "An unsigned DeFindex vault transaction, DeFindex's answer passed through. " +
    'Only `xdr` matters to a caller: sign it unchanged and submit it; the rest ' +
    'is for display.',
})
export class DefindexBuildEntity {
  @ApiProperty({
    example: 'AAAAAgAAAAB…',
    description:
      'The unsigned transaction (base64 envelope XDR), checked here to be the ' +
      'requested call for `caller` and recorded for the submit. Sign it ' +
      'unchanged: any other change makes it a transaction the submit refuses.',
  })
  xdr!: string;

  @ApiProperty({
    example: 'deposit',
    description: 'The vault function called.',
  })
  functionName!: string;

  @ApiProperty({
    type: 'array',
    items: {},
    description: "The call's arguments, as DeFindex decoded them.",
  })
  params!: unknown[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: "DeFindex's simulation of the transaction, verbatim.",
  })
  simulationResponse!: Record<string, unknown>;
}

/**
 * What a submit answers: DeFindex's own response for the broadcast, passed
 * through, and stored so a replay of the same transaction answers it again.
 */
@ApiSchema({
  description:
    "DeFindex's answer for a relayed transaction, passed through and stored, so " +
    'submitting the same transaction again answers it without calling DeFindex.',
})
export class DefindexSubmitResultEntity {
  @ApiProperty({
    example: '5f0e8a1d3c7b9e2f4a6c8d0b1e3f5a7c9d2b4e6f8a0c1d3e5f7a9b2c4d6e8f0a',
    description: 'The transaction hash (64 hex).',
  })
  txHash!: string;

  @ApiProperty({ description: 'Whether the transaction succeeded on-chain.' })
  success!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { type: 'vault_deposit', sharesMinted: '9950000' },
    description:
      "DeFindex's reading of the result: `vault_deposit` with `sharesMinted`, " +
      '`vault_withdraw` with `amountsOut`, or `unknown` with `value`.',
  })
  result!: Record<string, unknown> | null;

  @ApiProperty({ example: 61234567, description: 'The ledger it closed in.' })
  ledger!: number;

  @ApiPropertyOptional({
    example: '2026-11-01T12:00:00Z',
    description:
      'When the transaction was created, as DeFindex reports it (ISO 8601 date-time).',
  })
  createdAt?: string;

  @ApiPropertyOptional({
    example: 61234570,
    description: 'The latest ledger when DeFindex answered.',
  })
  latestLedger?: number;

  @ApiPropertyOptional({
    example: '2026-11-01T12:00:15Z',
    description: 'When `latestLedger` closed, as DeFindex reports it.',
  })
  latestLedgerCloseTime?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether DeFindex reports it as a fee bump transaction.',
  })
  feeBump?: boolean;

  @ApiPropertyOptional({ example: '104210', description: 'In stroops.' })
  feeCharged?: string;
}
