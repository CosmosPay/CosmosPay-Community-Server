import { ApiProperty } from '@nestjs/swagger';

export class CustomerTotalEntity {
  @ApiProperty({
    example: 'XLM',
    description: 'XLM for the native asset, otherwise the Stellar asset code.',
  })
  asset!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Issuer account for non-native assets.',
  })
  assetIssuer!: string | null;

  @ApiProperty({
    example: '100.0000000',
    description: 'Succeeded amount with exactly seven decimal places.',
  })
  amount!: string;

  @ApiProperty({ example: 3 })
  succeeded!: number;
}

export class CustomerEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'consumer_0001' })
  consumerId!: string;

  @ApiProperty({ example: 'Acme Inc.' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Acme — billing' })
  alias!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'billing@acme.com' })
  email!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  account!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'VIP customer' })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'cust_001' })
  reference!: string | null;

  @ApiProperty({
    example: 4,
    description: 'All payment intents for the account.',
  })
  payments!: number;

  @ApiProperty({ type: [CustomerTotalEntity] })
  totals!: CustomerTotalEntity[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CustomerListEntity {
  @ApiProperty({ type: [CustomerEntity] })
  data!: CustomerEntity[];

  @ApiProperty({ example: 1, description: 'Total number of stored customers.' })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
