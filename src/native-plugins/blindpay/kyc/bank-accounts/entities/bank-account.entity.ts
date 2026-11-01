import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay bank account (`ba_...`). */
@ApiSchema({
  description:
    "A receiver's fiat bank account as this service mirrors it: identifiers only, never the account numbers.",
})
export class BankAccountEntity {
  @ApiProperty({
    example: 'clz9xbank00001',
    description:
      'Cosmos Pay id of the bank account; pass it as `bank_account_id` to `POST /v1/offramp/quotes`.',
  })
  id!: string;

  @ApiProperty({
    example: 'ba_000000000000',
    description: "BlindPay's id for the bank account (`ba_...`).",
  })
  blindpayId!: string;

  @ApiPropertyOptional({
    example: 'ach',
    description:
      'Rail the account settles on: its BlindPay `type`, such as `ach`.',
  })
  rail!: string | null;

  @ApiPropertyOptional({
    example: 'Acme payouts (USD)',
    description: 'Label of the account, as BlindPay returned it.',
  })
  name!: string | null;

  @ApiPropertyOptional({
    example: 'US',
    description: 'Country of the account, as BlindPay returned it.',
  })
  country!: string | null;

  @ApiProperty({
    example: '2026-06-28T12:00:00.000Z',
    description: 'When this service recorded the account (ISO 8601 date-time).',
  })
  createdAt!: Date;
}

/** One page of bankaccounts — the envelope every list in this API returns. */
@ApiSchema({
  description: "One page of a receiver's bank accounts, newest first.",
})
export class BankAccountListEntity {
  @ApiProperty({
    type: [BankAccountEntity],
    description: 'The bank accounts on this page.',
  })
  data!: BankAccountEntity[];

  @ApiProperty({
    description: 'Matching rows, not the page length.',
    example: 1,
  })
  total!: number;

  @ApiProperty({
    example: 100,
    description:
      'The page size applied, from the `take` query parameter (default 100).',
  })
  take!: number;

  @ApiProperty({
    example: 0,
    description:
      'Rows skipped before this page, from the `skip` query parameter (default 0).',
  })
  skip!: number;
}

@ApiSchema({
  description:
    'Confirms a bank account deletion; an id the receiver does not have gets the same answer, so repeating a delete succeeds.',
})
export class BankAccountDeletedEntity {
  @ApiProperty({
    example: 'clz9xbank00001',
    description: 'The bank account id from the request path.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}
