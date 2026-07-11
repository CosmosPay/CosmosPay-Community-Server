import { ApiProperty } from '@nestjs/swagger';

export class ProductEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'Pro plan — monthly' })
  name!: string;

  @ApiProperty({ nullable: true, example: 'Full access, billed every month.' })
  description!: string | null;

  @ApiProperty({ nullable: true, example: '49.00' })
  amount!: string | null;

  @ApiProperty({
    example: 'native',
    description: 'Asset code, or "native" for XLM.',
  })
  asset!: string;

  @ApiProperty({ example: 'one_time', enum: ['recurring', 'one_time', 'link'] })
  kind!: string;

  @ApiProperty({ example: true })
  active!: boolean;

  @ApiProperty({ nullable: true, example: 'sku_pro_monthly' })
  reference!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class ProductDeletedEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}
