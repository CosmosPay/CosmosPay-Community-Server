import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** A Solana Pay transaction request's GET: what the wallet shows before asking. */
@ApiSchema({
  description:
    'Answer to a Solana Pay transaction request GET: the label and icon the wallet shows before asking for the account.',
})
export class SolanaPayInfoEntity {
  @ApiProperty({
    example: 'Cosmos Pay',
    description: 'Who requests the payment.',
  })
  label!: string;

  @ApiProperty({
    example: 'https://payments.cosmospay.lat/android-chrome-512x512.png',
    description: 'An absolute https URL of an image the wallet shows.',
  })
  icon!: string;
}

/** A Solana Pay transaction request's POST: the transaction the wallet signs. */
@ApiSchema({
  description:
    'Answer to a Solana Pay transaction request POST: the unsigned transaction the wallet signs.',
})
export class SolanaPayTransactionEntity {
  @ApiProperty({
    description:
      'The unsigned transaction (base64 wire bytes): the payment to the ' +
      'merchant, carrying the link’s reference, the merchant fee to its wallet, ' +
      'and the link’s memo. Fee payer: the account that asked.',
    example: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA...',
  })
  transaction!: string;

  @ApiPropertyOptional({
    description: 'The link’s message, for the wallet to show.',
    example: 'Order #24',
  })
  message?: string;
}
