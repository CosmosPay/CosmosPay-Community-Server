import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({ nullable: true, example: 'Acme — billing' })
  alias!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'ada@example.com' })
  email!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stellar account associated with this customer, if any.',
    example: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
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
    description: 'Payment intents attributed to this customer.',
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
    description: 'Total matching rows — not the page length.',
    example: 137,
  })
  total!: number;

  @ApiProperty({ example: 100 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

export class CustomerDeletedEntity {
  @ApiProperty({ example: 'clz9xcust00001' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}
