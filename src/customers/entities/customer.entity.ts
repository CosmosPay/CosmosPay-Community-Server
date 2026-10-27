import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CHAINS } from '@/chains/chains.constants';

/** A wallet of a customer, on one chain. */
export class CustomerWalletEntity {
  @ApiProperty({ example: 'cw4f0c2a9d1b7e83c5a6f9d2e1b0c3a7f8' })
  id!: string;

  @ApiProperty({ enum: CHAINS, example: 'stellar' })
  chain!: string;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description:
      'The address, in its chain\x27s stored spelling (EIP-55 on Monad).',
  })
  address!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Treasury' })
  label!: string | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
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
export class CustomerEntity {
  @ApiProperty({ example: 'clz9xcust00001' })
  id!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Acme (billing)' })
  alias!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'ada@example.com' })
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

  @ApiPropertyOptional({ nullable: true, example: 'Prefers wire settlement' })
  note!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'ext_4821' })
  reference!: string | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-21T12:34:57.000Z' })
  updatedAt!: Date;
}

/** A customer plus the payment counters `findAll` aggregates in PostgreSQL. */
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

export class CustomerListEntity {
  @ApiProperty({ type: [CustomerWithStatsEntity] })
  data!: CustomerWithStatsEntity[];

  @ApiProperty({
    description: 'Total matching rows, not the page length.',
    example: 137,
  })
  total!: number;

  @ApiProperty({ example: 100 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** The answer to removing a wallet from a customer. */
export class CustomerWalletDeletedEntity {
  @ApiProperty({ example: 'cw4f0c2a9d1b7e83c5a6f9d2e1b0c3a7f8' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}

export class CustomerDeletedEntity {
  @ApiProperty({ example: 'clz9xcust00001' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}
