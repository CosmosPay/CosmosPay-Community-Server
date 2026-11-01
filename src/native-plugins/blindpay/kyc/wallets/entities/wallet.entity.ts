import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay blockchain wallet (`bw_...`). */
@ApiSchema({
  description: "A receiver's blockchain wallet as this service mirrors it.",
})
export class WalletEntity {
  @ApiProperty({
    example: 'clz9xwallet001',
    description:
      'Cosmos Pay id of the wallet; pass it as `blockchain_wallet_id` to onramp quotes and virtual accounts.',
  })
  id!: string;

  @ApiProperty({
    example: 'bw_000000000000',
    description: "BlindPay's wallet id (`bw_...`).",
  })
  blindpayId!: string;

  @ApiPropertyOptional({
    example: 'Primary wallet',
    description: 'Label of the wallet.',
  })
  name!: string | null;

  @ApiProperty({
    example: 'stellar',
    description: 'BlindPay network the wallet is on (for example `stellar`).',
  })
  network!: string;

  @ApiPropertyOptional({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description: 'Wallet address on `network`.',
  })
  address!: string | null;

  @ApiProperty({
    example: false,
    description: 'Whether the wallet is an account-abstraction wallet.',
  })
  isAccountAbstraction!: boolean;

  @ApiProperty({
    example: '2026-06-28T12:00:00.000Z',
    description: 'When this service recorded the wallet (ISO 8601 date-time).',
  })
  createdAt!: Date;
}

/** One page of wallets — the envelope every list in this API returns. */
@ApiSchema({ description: "One page of a receiver's wallets, newest first." })
export class WalletListEntity {
  @ApiProperty({
    type: [WalletEntity],
    description: 'The wallets on this page.',
  })
  data!: WalletEntity[];

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
    'Confirms a wallet deletion; an id the receiver does not have gets the same answer, so repeating a delete succeeds.',
})
export class WalletDeletedEntity {
  @ApiProperty({
    example: 'clz9xwallet001',
    description: 'The wallet id from the request path.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}
