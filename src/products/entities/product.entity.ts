import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  description:
    'A catalog product of the consumer: a name, an optional price and an informational kind.',
})
export class ProductEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Product id.',
  })
  id!: string;

  @ApiProperty({ example: 'Pro plan (monthly)', description: 'Product name.' })
  name!: string;

  @ApiProperty({
    nullable: true,
    example: 'Full access, billed every month.',
    description: 'Description of the product; null when none was given.',
  })
  description!: string | null;

  @ApiProperty({
    nullable: true,
    example: '49.00',
    description:
      'Price as a decimal string in `asset`; null for a customer-set amount.',
  })
  amount!: string | null;

  @ApiProperty({
    example: 'native',
    description: 'Asset code, or "native" for XLM.',
  })
  asset!: string;

  @ApiProperty({
    example: 'one_time',
    enum: ['recurring', 'one_time', 'link'],
    description:
      'Informational classification: `recurring`, `one_time` or `link`.',
  })
  kind!: string;

  @ApiProperty({
    example: true,
    description:
      'Whether the product is active; inactive products are kept and still listed.',
  })
  active!: boolean;

  @ApiProperty({
    nullable: true,
    example: 'sku_pro_monthly',
    description: 'Your own SKU or reference; null when none was given.',
  })
  reference!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When the product was created (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'When the product last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

@ApiSchema({
  description:
    "One page of the consumer's products, newest first, inactive ones included.",
})
export class ProductListEntity {
  @ApiProperty({
    type: [ProductEntity],
    description: 'The products on this page, newest first.',
  })
  data!: ProductEntity[];

  @ApiProperty({
    example: 137,
    description: 'Total products matching the query, not the page size.',
  })
  total!: number;

  @ApiProperty({ example: 100, description: 'Page size applied (1 to 100).' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of products skipped before this page.',
  })
  skip!: number;
}

@ApiSchema({ description: 'Confirmation that a product was deleted.' })
export class ProductDeletedEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Id of the deleted product.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}
