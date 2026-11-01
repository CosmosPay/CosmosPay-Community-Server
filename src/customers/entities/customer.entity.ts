import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { CHAINS } from '@/chains/chains.constants';

/** A wallet of a customer, on one chain. */
@ApiSchema({ description: 'A wallet of a customer, on one chain.' })
export class CustomerWalletEntity {
  @ApiProperty({
    example: 'cw4f0c2a9d1b7e83c5a6f9d2e1b0c3a7f8',
    description: 'Wallet id, used to remove it from the customer.',
  })
  id!: string;

  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'The chain the wallet is on.',
  })
  chain!: string;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description:
      'The address, in its chain\x27s stored spelling (EIP-55 on Monad).',
  })
  address!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Treasury',
    description:
      'A name for the wallet, shown beside the address; null when none was given.',
  })
  label!: string | null;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the wallet was added (ISO 8601).',
  })
  createdAt!: Date;
}

/**
 * A merchant-managed customer record.
 *
 * These routes shipped with no `@ApiOkResponse` at all, so the published spec
 * recorded five endpoints with an empty description and no schema — an
 * integrator could not discover the response shape, or that `findAll` is
 * paginated, without reading the source.
 */
@ApiSchema({
  description: 'A merchant-managed customer record with its wallets.',
})
export class CustomerEntity {
  @ApiProperty({ example: 'clz9xcust00001', description: 'Customer id.' })
  id!: string;

  @ApiProperty({ example: 'Ada Lovelace', description: 'Customer name.' })
  name!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Acme (billing)',
    description: 'Alternative display name; null when none was given.',
  })
  alias!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'ada@example.com',
    description: 'Contact email address; null when none was given.',
  })
  email!: string | null;

  @ApiProperty({
    type: [CustomerWalletEntity],
    description:
      'The customer\x27s wallets, oldest first, on any chain payments settle on.',
  })
  wallets!: CustomerWalletEntity[];

  @ApiPropertyOptional({
    nullable: true,
    deprecated: true,
    description:
      'Deprecated: read `wallets`. The first wallet\x27s address, kept for clients written ' +
      'when a customer held one account; null without wallets.',
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  account!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Prefers wire settlement',
    description: 'Free-text note about the customer; null when none was given.',
  })
  note!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'ext_4821',
    description:
      'Your own reference for the customer; `auto` for a payer added automatically from a settled payment; null when none.',
  })
  reference!: string | null;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the customer was created (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-21T12:34:57.000Z',
    description: 'When the customer last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

/** A customer plus the payment counters `findAll` aggregates in PostgreSQL. */
@ApiSchema({
  description:
    "A customer with the payment counters of the intents paid from its wallets, on the key's network.",
})
export class CustomerWithStatsEntity extends CustomerEntity {
  @ApiProperty({
    description:
      'Payment intents whose payer (`source`) is one of this customer’s wallets, on that ' +
      'wallet\x27s chain and the network the API key targets.',
    example: 12,
  })
  payments!: number;

  @ApiProperty({ description: 'How many of those succeeded.', example: 11 })
  succeeded!: number;

  @ApiProperty({
    description: 'Gross settled volume, an exact decimal string.',
    example: '1042.5',
  })
  total!: string;
}

@ApiSchema({
  description:
    "One page of the consumer's customers, newest first, each with its payment counters.",
})
export class CustomerListEntity {
  @ApiProperty({
    type: [CustomerWithStatsEntity],
    description: 'The customers on this page, newest first.',
  })
  data!: CustomerWithStatsEntity[];

  @ApiProperty({
    description: 'Total matching rows, not the page length.',
    example: 137,
  })
  total!: number;

  @ApiProperty({ example: 100, description: 'Page size applied (1 to 100).' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of customers skipped before this page.',
  })
  skip!: number;
}

/** The answer to removing a wallet from a customer. */
@ApiSchema({
  description: 'Confirmation that a wallet was removed from a customer.',
})
export class CustomerWalletDeletedEntity {
  @ApiProperty({
    example: 'cw4f0c2a9d1b7e83c5a6f9d2e1b0c3a7f8',
    description: 'Id of the removed wallet.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}

@ApiSchema({
  description: 'Confirmation that a customer and its wallets were deleted.',
})
export class CustomerDeletedEntity {
  @ApiProperty({
    example: 'clz9xcust00001',
    description: 'Id of the deleted customer.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}
