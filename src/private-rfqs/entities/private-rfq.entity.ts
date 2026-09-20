import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PrivateQuoteEntity {
  @ApiProperty()
  provider!: string;

  @ApiProperty()
  revealed!: boolean;

  @ApiProperty()
  valid!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Quote base units.',
  })
  amount!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Object })
  proposal!: Record<string, unknown> | null;
}

export class PrivateRfqEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  reference!: string;

  @ApiProperty({ enum: ['public', 'testnet'] })
  network!: string;

  @ApiProperty()
  contractId!: string;

  @ApiProperty()
  roundId!: string;

  @ApiProperty({
    enum: ['OPEN', 'REVEALING', 'REVEALED', 'SELECTED', 'VOIDED'],
  })
  status!: string;

  @ApiProperty()
  roundStatus!: string;

  @ApiProperty({ format: 'date-time' })
  commitDeadline!: Date;

  @ApiProperty({ format: 'date-time' })
  revealDeadline!: Date;

  @ApiProperty()
  assetCode!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  assetIssuer!: string | null;

  @ApiProperty()
  assetDecimals!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  selectedProvider!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  selectedAmount!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  paymentIntentId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: [PrivateQuoteEntity] })
  quotes?: PrivateQuoteEntity[];
}

export class PrivateRfqListEntity {
  @ApiProperty({ type: [PrivateRfqEntity] })
  data!: PrivateRfqEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  take!: number;

  @ApiProperty()
  skip!: number;
}

export class PrivateRfqPaymentEntity {
  @ApiProperty({ type: PrivateRfqEntity })
  privateRfq!: PrivateRfqEntity;

  @ApiProperty({ type: Object })
  paymentIntent!: Record<string, unknown>;
}
